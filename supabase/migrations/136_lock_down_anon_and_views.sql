-- 136_lock_down_anon_and_views.sql
--
-- Security round (2026-10-17 audit). Three holes, all reachable with the
-- anon key that ships inside the web bundle:
--
--   1. Supabase's default privileges grant EXECUTE on every new function
--      in `public` to anon, authenticated and service_role. The migrations
--      only ever ran `revoke all on function ... from public`, which does
--      NOT remove a grant made directly to anon. So attention_inbox,
--      claim_outbound_dispatch, transition_lead_status, upsert_lead_smart
--      and the rest were callable through /rest/v1/rpc with the anon key.
--      merge_leads (083/132) was the one function that revoked from anon
--      explicitly — the authors knew the pitfall; it just never became
--      the convention.
--   2. Views run with their OWNER's rights unless created with
--      security_invoker (057's comment claims the opposite). `contacts` is
--      `select * from leads`, owned by postgres, so RLS on leads never
--      fired for anyone reading the view — and default privileges gave
--      anon SELECT on every view in public.
--   3. 17 policies are `for all to authenticated using (is_active_staff())`.
--      Every write from the web goes through an Edge Function with the
--      service-role key (which bypasses RLS), so those write grants only
--      served a viewer with the anon key and their own JWT who wanted to,
--      say, insert a scheduled WhatsApp broadcast straight into
--      `broadcasts` and have broadcast-dispatch send it.
--
-- Idempotent: every statement re-applies cleanly.

-- ── 1. Functions ──────────────────────────────────────────────────────
-- anon never calls an RPC (the web app calls none; the landing-page
-- renderer reads a table). Close every function to it.
--
-- Two grants must go, not one. Postgres gives EXECUTE on every new function
-- to PUBLIC (`=X/postgres` in proacl) — that is the grant the migrations
-- revoked with `revoke ... from public`, and 13 of them never did (027, 030,
-- 032, 033, 034, 035, 036, 122 only ever GRANTed to service_role). Supabase
-- adds an explicit grant to anon on top. `revoke from anon` alone leaves
-- the PUBLIC grant, and anon is a member of PUBLIC: team_workload_summary()
-- and bulk_change_lead_heat() stayed callable with the anon key after the
-- first draft of this migration (caught in review by actually calling them
-- as `set role anon`). So: revoke from PUBLIC and anon on every function,
-- then grant back exactly what each role needs.
do $$
declare
  f record;
  -- The web app calls these three through PostgREST with a staff JWT, and
  -- RLS policies evaluate the helpers as the querying role.
  keep_authenticated text[] := array[
    'is_active_staff', 'has_role', 'current_user_role',
    'attention_inbox', 'dashboard_summary', 'advance_deal_stage'
  ];
begin
  for f in
    select p.oid::regprocedure as sig, p.proname as name, p.prorettype = 'trigger'::regtype as is_trigger
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    -- Service role runs every Edge Function; triggers fire as the table
    -- owner's mechanism and keep their existing explicit grants.
    execute format('grant execute on function %s to service_role', f.sig);
    if f.name = any (keep_authenticated) or f.is_trigger then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

-- Supabase's per-schema default grant to anon is dropped so a future
-- function does not get it back. The PUBLIC default is global (a per-schema
-- REVOKE cannot undo it — Postgres docs), so the convention stays: every
-- new function ends with `revoke all on function ... from public` and a
-- grant to the roles that need it. db-smoke now fails when any non-trigger
-- function in public is executable by anon, or by authenticated outside
-- the allowlist above, so a forgotten revoke cannot reach production.
alter default privileges in schema public revoke execute on functions from anon;

-- Service-only RPCs: the Edge Functions call these with the service-role
-- key. A signed-in staff member has no business calling them through
-- PostgREST (claim_outbound_dispatch stalls deliveries for 15 minutes a
-- call; transition_lead_status skips every guard the Edge Functions add).
-- RLS helpers (is_active_staff, has_role, current_user_role), the three
-- RPCs the web legitimately exposes (attention_inbox, dashboard_summary,
-- advance_deal_stage) and trigger functions keep their authenticated grant.
do $$
declare
  f record;
  svc_only text[] := array[
    'apply_lead_score_decay', 'bootstrap_onboarding', 'bulk_assign_lead_owner',
    'bulk_change_lead_heat', 'check_rate_limit', 'claim_job_run', 'claim_outbound_dispatch',
    'compact_integration_logs', 'complete_outbound_dispatch',
    'enqueue_dormant_reactivation_reviews', 'enqueue_won_without_provisioning_reviews',
    'escalate_stale_handoffs', 'fail_outbound_dispatch', 'finalize_job_run', 'merge_leads',
    'pick_prompt_variant', 'purge_automation_runs', 'purge_expired_webhook_idempotency',
    'purge_operator_alerts', 'purge_rate_limit_buckets', 'purge_removed_pii',
    'purge_webhook_inbox', 'release_conversation_lock', 'reopen_lead', 'run_ai_watchdog',
    'run_automation_tick', 'run_broadcast_dispatch', 'run_daily_sales_inbox',
    'run_email_replies_poll', 'run_nightly_jobs', 'run_operator_digest', 'run_outbound_dispatch',
    'run_sla_worker', 'run_template_sync', 'team_workload_summary', 'transition_lead_status',
    'try_conversation_lock', 'upsert_lead_by_igsid', 'upsert_lead_by_phone', 'upsert_lead_smart',
    -- Created in production outside the migrations (conversation-claims
    -- Edge Function); the loop simply finds nothing for them locally.
    'claim_conversation', 'release_conversation'
  ];
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and p.proname = any (svc_only)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

-- ── 2. Views ──────────────────────────────────────────────────────────
-- security_invoker: the reader's own RLS applies to the underlying tables
-- (service_role bypasses RLS, so the Edge Functions are unaffected). And
-- no view is readable with the anon key.
do $$
declare
  v record;
begin
  for v in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
  loop
    execute format('alter view public.%I set (security_invoker = true)', v.relname);
    execute format('revoke all on public.%I from anon', v.relname);
    execute format('grant select on public.%I to authenticated, service_role', v.relname);
  end loop;
end $$;

alter default privileges in schema public revoke all on tables from anon;

comment on view public.contacts is
  'Alias for the Lead-centric `leads` table (Tier 0.E). security_invoker = true since '
  'migration 136: a Postgres view runs with its OWNER''s rights unless told otherwise, so '
  'until then this view bypassed RLS on leads.';

-- ── 3. Policies ───────────────────────────────────────────────────────
-- Every `for all to authenticated` policy becomes `for select` with the
-- same predicate. Writes keep flowing through the Edge Functions
-- (service_role). Dynamic so a policy added by a later migration with the
-- same shape is handled the same way if this file is re-applied.
do $$
declare
  p record;
begin
  for p in
    select policyname, tablename, qual
    from pg_policies
    where schemaname = 'public'
      and cmd = 'ALL'
      and roles = '{authenticated}'::name[]
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
    execute format(
      'create policy %I on public.%I for select to authenticated using (%s)',
      p.policyname, p.tablename, coalesce(p.qual, 'true')
    );
  end loop;
end $$;

-- profiles_admin_update (005) let any admin UPDATE any profile row through
-- PostgREST — their own `role` to 'owner' included. Profile changes go
-- through users-manage (service_role), which since this round enforces who
-- may change whom; the table-level write path must not stay open beside it.
drop policy if exists profiles_admin_update on public.profiles;

-- conversation_claims was created in production outside the migrations
-- (029 only publishes it) and is the one public table db-smoke found with
-- RLS off. Only the conversation-claims Edge Function (service_role) reads
-- or writes it.
alter table if exists public.conversation_claims enable row level security;
do $$ begin
  if to_regclass('public.conversation_claims') is not null then
    -- LeadDetailPage subscribes to realtime changes on this table; realtime
    -- delivers a row only to subscribers whose RLS allows SELECT on it.
    drop policy if exists conversation_claims_staff_read on public.conversation_claims;
    create policy conversation_claims_staff_read on public.conversation_claims
      for select to authenticated using (public.is_active_staff());
  end if;
end $$;

-- `landing_pages_public_read` (108, anon SELECT on active pages) is a
-- deliberate exception: api/lp/[slug].ts renders public landing pages with
-- the anon key. It is `for select`, so the loop above never touched it, and
-- the table grant anon needs for it stays in place.
grant select on public.landing_pages to anon;
