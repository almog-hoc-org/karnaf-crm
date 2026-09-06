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

-- Without this every "recent runs" question is a sequential scan of the
-- whole history. Built after the drain so it is cheap.
create index if not exists job_run_details_start_time_idx
  on cron.job_run_details (start_time desc);
