-- 138_conversation_turn_lease.sql
--
-- The per-conversation lock (008) was pg_try_advisory_lock — a SESSION-level
-- lock — taken and released through two separate PostgREST requests. The
-- API runs each request on whichever pooled connection is free, so the lock
-- lived on connection A and the release ran on connection B, where
-- pg_advisory_unlock returned false (with a WARNING nobody read). The lock
-- stayed on A until that connection was recycled; every later turn for the
-- same conversation that landed on another connection got `locked`, which
-- dispatch-outbound retries at 1m/4m/16m/1h and then dead-letters — the
-- customer's second message was never answered.
--
-- Replaced by a lease row: one conditional UPDATE claims the turn for a
-- bounded time, the release clears it. No connection affinity, and a turn
-- that crashes mid-way frees itself when the lease expires.

alter table public.conversations
  add column if not exists turn_lock_until timestamptz;

comment on column public.conversations.turn_lock_until is
  'Lease taken by orchestrate-message for the duration of one AI turn (claim_conversation_turn). '
  'NULL or in the past = free. Replaces the session advisory lock from 008.';

create or replace function public.claim_conversation_turn(p_conversation_id uuid, p_ttl_seconds int default 180)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_claimed int;
begin
  update public.conversations
     set turn_lock_until = now() + make_interval(secs => greatest(5, least(p_ttl_seconds, 900)))
   where id = p_conversation_id
     and (turn_lock_until is null or turn_lock_until < now());
  get diagnostics v_claimed = row_count;
  return v_claimed = 1;
end;
$$;

create or replace function public.release_conversation_turn(p_conversation_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_released int;
begin
  update public.conversations
     set turn_lock_until = null
   where id = p_conversation_id
     and turn_lock_until is not null;
  get diagnostics v_released = row_count;
  return v_released = 1;
end;
$$;

revoke all on function public.claim_conversation_turn(uuid, int) from public, anon, authenticated;
revoke all on function public.release_conversation_turn(uuid) from public, anon, authenticated;
grant execute on function public.claim_conversation_turn(uuid, int) to service_role;
grant execute on function public.release_conversation_turn(uuid) to service_role;

-- The advisory-lock RPCs stay callable for one deploy cycle (an Edge
-- Function bundle built before this migration may still call them) but are
-- marked for removal.
comment on function public.try_conversation_lock(int, int) is
  'DEPRECATED since 138 — session advisory lock leaked across the PostgREST pool. Use claim_conversation_turn.';
comment on function public.release_conversation_lock(int, int) is
  'DEPRECATED since 138 — see claim_conversation_turn / release_conversation_turn.';
