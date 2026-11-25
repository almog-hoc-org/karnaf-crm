-- 144_fix_purge_rate_limit.sql
--
-- The hourly cron job karnaf_purge_rate_limit has failed on every run that
-- had more than one stale bucket to delete:
--
--   ERROR: query returned more than one row
--   HINT:  Make sure the query returns a single row, or use LIMIT 1.
--
-- purge_rate_limit_buckets() (011) wrote `delete ... returning 1 into
-- v_deleted` and then overwrote v_deleted with GET DIAGNOSTICS. A RETURNING
-- ... INTO in PL/pgSQL is a single-row assignment, so the delete itself
-- aborts as soon as two buckets qualify, nothing is purged, and the table
-- grows by one row per distinct webhook key. Only GET DIAGNOSTICS was ever
-- needed for the count.
--
-- Found in the production ops report of 2026-11-25 ("cron last run per job").

create or replace function public.purge_rate_limit_buckets() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_deleted int;
begin
  delete from webhook_rate_limit where window_started_at < now() - interval '1 hour';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all on function public.purge_rate_limit_buckets() from public, anon, authenticated;
grant execute on function public.purge_rate_limit_buckets() to service_role;
