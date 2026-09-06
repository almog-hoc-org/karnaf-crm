-- 125_cron_history_hygiene.sql
--
-- pg_cron writes one row to cron.job_run_details per run and never deletes
-- any. This project schedules eleven jobs, two of them every minute
-- (outbound_dispatch, broadcast_dispatch) — roughly 3,500 rows a day, for
-- months. The diagnostic on 2026-09-06 could not complete a single query
-- against the table in five attempts; everything else on the instance
-- answered. A log table nobody reads past a day should not be the largest
-- thing in the database.
--
-- Keep 14 days. The ops runbook only ever asks "what ran in the last 24h".

-- Purge in batches so the lock stays short on an instance that is already
-- struggling; a single unbounded DELETE over months of rows is exactly the
-- kind of statement that would tip it over.
do $$
declare
  v_deleted integer;
  v_total integer := 0;
begin
  loop
    delete from cron.job_run_details
    where runid in (
      select runid from cron.job_run_details
      where end_time < now() - interval '14 days'
      limit 20000
    );
    get diagnostics v_deleted = row_count;
    v_total := v_total + v_deleted;
    exit when v_deleted = 0;
  end loop;
  raise notice 'cron.job_run_details purge: % rows deleted', v_total;
end $$;

-- The runbook queries filter on start_time; without this every question
-- about "recent runs" is a sequential scan of the whole history.
create index if not exists job_run_details_start_time_idx
  on cron.job_run_details (start_time desc);

-- Nightly, so it never grows back.
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'karnaf_purge_cron_history') then
    perform cron.schedule('karnaf_purge_cron_history', '15 3 * * *',
      $cmd$ delete from cron.job_run_details where end_time < now() - interval '14 days'; $cmd$);
  end if;
end $$;
