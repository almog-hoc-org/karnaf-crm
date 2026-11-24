-- 142_drop_stray_write_policies.sql
--
-- The production privilege probe after migration 141 (ops workflow,
-- 2026-10-20) still listed nine PERMISSIVE write policies for the
-- `authenticated` role — INSERT/UPDATE/DELETE on conversation_claims,
-- ai_decision_reviews, objections and outbound_email_drafts. None of them
-- exists in any migration: the tables (or the policies) were created in
-- production by hand, so 136's conversion loop — which only rewrote
-- `for all` policies — never saw them, and db-smoke, which runs on a
-- database built from the migrations alone, could not either.
--
-- Nothing in the web app, api/ or the Edge Functions writes these tables
-- with a user session (every write goes through service_role, which
-- bypasses RLS), so each of these policies was only an open door: any
-- signed-in staff account, viewer included, could write the rows through
-- PostgREST. Same rule as 136, applied to every shape of write policy:
-- reads stay, writes go through the Edge Functions.
--
-- Two corrections to 136's rule, found by the review of this file:
--   * a policy's role list may be {public} (the dashboard default, and a
--     policy written without TO) or {anon, authenticated}; a predicate on
--     roles = '{authenticated}' never saw those. Any overlap with
--     anon / authenticated / public counts.
--   * a `for all` policy with no USING clause lets a signed-in user read
--     NOTHING (Postgres adds a constant-false qual); rewriting it with
--     coalesce(qual, 'true') turned deny-all into allow-all. No USING →
--     nothing to keep → the policy is dropped.
-- The read half that is kept is granted to authenticated only: anon and
-- public never read a staff table (136), whatever the hand-made policy said.
--
-- The rule lives in a function so db-smoke can exercise it on policies of
-- every shape; the migration calls it once.

create or replace function public.close_stray_write_policies() returns integer
language plpgsql
set search_path = public
as $$
declare
  p record;
  n integer := 0;
begin
  -- `for all` → `for select` with the same USING predicate (136's rule).
  for p in
    select policyname, tablename, qual
    from pg_policies
    where schemaname = 'public'
      and cmd = 'ALL'
      and permissive = 'PERMISSIVE'
      and roles && '{anon,authenticated,public}'::name[]
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
    if p.qual is null then
      raise notice 'close_stray_write_policies: dropped ALL policy %.% (no USING clause, no read half to keep)', p.tablename, p.policyname;
    else
      execute format(
        'create policy %I on public.%I for select to authenticated using (%s)',
        p.policyname, p.tablename, p.qual
      );
      raise notice 'close_stray_write_policies: rewrote policy %.% from ALL to SELECT (authenticated)', p.tablename, p.policyname;
    end if;
    n := n + 1;
  end loop;

  -- Plain write policies have no read half to keep.
  for p in
    select policyname, tablename, cmd
    from pg_policies
    where schemaname = 'public'
      and cmd in ('INSERT', 'UPDATE', 'DELETE')
      and permissive = 'PERMISSIVE'
      and roles && '{anon,authenticated,public}'::name[]
  loop
    raise notice 'close_stray_write_policies: dropped % policy %.%', p.cmd, p.tablename, p.policyname;
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
    n := n + 1;
  end loop;
  return n;
end;
$$;

comment on function public.close_stray_write_policies() is
  'Drops every PERMISSIVE write policy (INSERT/UPDATE/DELETE, or the write half of FOR ALL) that any '
  'user-facing role (anon, authenticated, public) holds on a table in public. Writes go through the '
  'Edge Functions (service_role). Dropping a policy needs table ownership, so only the migration role '
  'can act with it; the grant to service_role follows the project convention.';
revoke all on function public.close_stray_write_policies() from public, anon, authenticated;
grant execute on function public.close_stray_write_policies() to service_role;

select public.close_stray_write_policies() as policies_closed;

-- A table that had only write policies for staff keeps no read path either;
-- that is intended for the two hand-made tables nobody in the codebase
-- reads (objections, outbound_email_drafts). conversation_claims and
-- ai_decision_reviews keep their *_staff_read policies from 136 / 120.
