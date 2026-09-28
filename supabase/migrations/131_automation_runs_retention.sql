-- 131_automation_runs_retention.sql
--
-- automation_runs had no retention at all, and the engine wrote a
-- 'skipped / conditions did not match' row for every lead × rule it
-- evaluated. With the time rules live (automation-tick every 10 min over
-- ~300 leads and 5 rules) that is ~200k rows a day — the same shape as
-- the sla_breach flood that emptied the chat screen (migration 123).
--
-- The engine no longer logs non-matches (_shared/automation-engine.ts).
-- This migration adds the retention the table never had:
--   * leftover non-match rows go first, whatever their age;
--   * other 'skipped' rows (contact guard, once-gate) after 14 days;
--   * everything else after 90 days — enough to answer "did this rule
--     fire for that lead last quarter?".
-- Deletes are batched so a large backlog never trips statement_timeout;
-- the nightly job keeps chipping at it.

create index if not exists idx_automation_runs_created
  on public.automation_runs(created_at);

create or replace function public.purge_automation_runs(p_batch int default 20000)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  with doomed as (
    select id from public.automation_runs
     where reason = 'conditions did not match'
        or (status = 'skipped' and created_at < now() - interval '14 days')
        or created_at < now() - interval '90 days'
     limit greatest(p_batch, 1)
  )
  delete from public.automation_runs r
   using doomed
   where r.id = doomed.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_automation_runs(int) from public;
grant execute on function public.purge_automation_runs(int) to service_role;

-- 03:25 UTC: after the cron-history purge (03:15), away from the
-- top-of-hour jobs.
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'karnaf_purge_automation_runs') then
    perform cron.schedule('karnaf_purge_automation_runs', '25 3 * * *',
      $cmd$ select public.purge_automation_runs(); $cmd$);
  end if;
end $$;

-- First pass now, bounded, so the backlog starts shrinking with the deploy.
select public.purge_automation_runs(20000);
