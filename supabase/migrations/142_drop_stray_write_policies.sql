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
-- Written as a loop over pg_policies rather than nine fixed names so that
-- the same file closes a policy of this shape wherever it turns up, and
-- is a no-op on a database that has none (db-smoke).

do $$
declare
  p record;
begin
  -- `for all` → `for select` with the same predicate (136's rule).
  for p in
    select policyname, tablename, qual
    from pg_policies
    where schemaname = 'public'
      and cmd = 'ALL'
      and roles = '{authenticated}'::name[]
      and permissive = 'PERMISSIVE'
  loop
    raise notice 'migration 142: rewriting policy %.% from ALL to SELECT', p.tablename, p.policyname;
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
    execute format(
      'create policy %I on public.%I for select to authenticated using (%s)',
      p.policyname, p.tablename, coalesce(p.qual, 'true')
    );
  end loop;

  -- Plain write policies have no read half to keep.
  for p in
    select policyname, tablename, cmd
    from pg_policies
    where schemaname = 'public'
      and cmd in ('INSERT', 'UPDATE', 'DELETE')
      and roles = '{authenticated}'::name[]
      and permissive = 'PERMISSIVE'
  loop
    raise notice 'migration 142: dropping % policy %.%', p.cmd, p.tablename, p.policyname;
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- A table that had only write policies for staff keeps no read path either;
-- that is intended for the two hand-made tables nobody in the codebase
-- reads (objections, outbound_email_drafts). conversation_claims and
-- ai_decision_reviews keep their *_staff_read policies from 136 / 120.
