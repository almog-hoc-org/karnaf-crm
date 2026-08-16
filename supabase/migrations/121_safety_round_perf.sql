-- 121_safety_round_perf.sql
--
-- Two performance corrections, both for queries that run constantly.
--
-- 1. LEAD SEARCH HAS NO INDEX. leads-list searches with
--    `ilike '%term%'` across full_name, phone and email. A leading
--    wildcard cannot use a btree index, full_name has no index at all,
--    and the leads list polls every 30 seconds — so operator search has
--    been a sequential scan of the whole leads table, repeatedly.
--    pg_trgm turns all three into index lookups.
--
--    messages.content_text is deliberately NOT indexed here: it is the
--    largest table in the schema, a GIN build inside a transactional
--    migration would hold a write lock for its duration, and that search
--    is operator-initiated and already capped at 500 rows.
--
-- 2. THE NIGHTLY SCORE DECAY WAS REWRITING updated_at. Its UPDATE fires
--    trg_leads_set_updated_at, so every idle lead with a score above zero
--    got a fresh updated_at every night. Consequences: the leads list
--    (sorted by updated_at desc) surfaced leads nobody had touched, and
--    lead-journey-manager's `order by updated_at asc` scan window churned.
--    "Last updated" stopped meaning "last activity".
--
--    The fix needs care. The nightly touch is also, accidentally, what
--    kept decay at the documented ~1 point per WEEK: the predicate
--    `updated_at < now() - 7 days` went true again every night once the
--    touching stopped. Simply suppressing the touch would silently
--    accelerate decay to 7 points a week, so the rate now has its own
--    column instead of riding on a side effect.

-- ── 1. Trigram search ────────────────────────────────────────────────
create extension if not exists pg_trgm;

create index if not exists idx_leads_full_name_trgm
  on public.leads using gin (full_name gin_trgm_ops);
create index if not exists idx_leads_phone_trgm
  on public.leads using gin (phone gin_trgm_ops);
create index if not exists idx_leads_email_trgm
  on public.leads using gin (email gin_trgm_ops);

-- Rolling-24h template count in broadcast-dispatch, which runs every
-- minute and now counts every proactive template (not just broadcasts).
create index if not exists idx_outbound_dispatch_template_recent
  on public.outbound_dispatch (created_at)
  where (payload->>'kind') = 'template';

-- ── 2. Decay that leaves updated_at alone ────────────────────────────
alter table public.leads
  add column if not exists last_score_decay_at timestamptz;

comment on column public.leads.last_score_decay_at is
  'When apply_lead_score_decay last decremented this lead. Paces decay at '
  '1 point/week without relying on updated_at being rewritten.';

-- Opt-out hatch for bulk maintenance writes. Default (unset) behaviour is
-- byte-identical to before, which matters: this trigger also serves
-- profiles.
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('karnaf.skip_touch_updated_at', true), '') = 'on' then
    return new;
  end if;
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.apply_lead_score_decay() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  -- Transaction-local: reset automatically at commit/rollback, so a
  -- failure here cannot leave the touch disabled for other writers.
  perform set_config('karnaf.skip_touch_updated_at', 'on', true);

  with updated as (
    update leads
       set lead_score = greatest(0, lead_score - 1),
           last_score_decay_at = now()
    where lead_status not in ('won','lost','do_not_contact','removed_by_request',
                               'active_student','onboarding_active','duplicate')
      and updated_at < now() - interval '7 days'
      and (last_score_decay_at is null or last_score_decay_at < now() - interval '7 days')
      and lead_score > 0
    returning id
  )
  select count(*)::int into v_count from updated;

  perform set_config('karnaf.skip_touch_updated_at', 'off', true);
  return v_count;
end;
$$;
revoke all on function public.apply_lead_score_decay() from public;
grant execute on function public.apply_lead_score_decay() to service_role;
