-- 125_cron_history_hygiene.sql
--
-- pg_cron writes one row to cron.job_run_details per run and never deletes
-- any. This project schedules eleven jobs, two of them every minute
-- (outbound_dispatch, broadcast_dispatch) — roughly 3,500 rows a day, for
-- months. On 2026-09-06 not a single query against the table completed
-- through the Management API; everything else on the instance answered. A
-- log table nobody reads past a day should not be the largest thing in the
-- database.
--
-- The one-time purge of the backlog is NOT here: it is far too large for a
-- single statement under the API's statement_timeout (the first attempt
-- died on exactly that), so the ops workflow drains it in primary-key
-- batches, each its own statement. This migration only makes sure it never
-- grows back, and indexes what the runbooks actually filter on.

-- Nightly purge, keeping 14 days — the runbooks only ever ask "what ran in
-- the last 24 hours".
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'karnaf_purge_cron_history') then
    perform cron.schedule('karnaf_purge_cron_history', '15 3 * * *',
      $cmd$ delete from cron.job_run_details where end_time < now() - interval '14 days'; $cmd$);
  end if;
end $$;

-- No index: cron.job_run_details is owned by supabase_admin, and the
-- migration runner (postgres, via the Management API) may delete from it
-- but not alter it — the first deploy of this file died on exactly
-- "42501: must be owner of table job_run_details". With the table held to
-- 14 days (~50k rows) the "recent runs" queries are cheap without one.
