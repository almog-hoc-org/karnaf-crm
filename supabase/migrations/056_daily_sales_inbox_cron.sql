-- 056_daily_sales_inbox_cron.sql
--
-- Tier 0.D — Mia's morning briefing.
-- Schedules the daily-sales-inbox edge function once a day at
-- 05:00 UTC (~08:00 Israel summer / 07:00 winter). Mia opens her day
-- with one Telegram message telling her exactly how many leads are at
-- risk, broken down by lane (reply / call / risk / ops) and kind.
--
-- The function URL comes from app.daily_sales_inbox_url, mirroring the
-- pattern set by 009_scheduled_jobs and 013_scheduled_nightly so Almog
-- can rotate URLs without redeploying migrations.

create or replace function public.run_daily_sales_inbox() returns void
language plpgsql security definer set search_path = public, extensions, vault as $$
declare
  v_url text := current_setting('app.daily_sales_inbox_url', true);
  v_secret text;
begin
  begin
    select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'sla_worker_secret' limit 1;
  exception when others then v_secret := null; end;

  if v_url is null or v_url = '' then
    raise notice 'daily_sales_inbox_url not set; skipping';
    return;
  end if;
  if v_secret is null then
    raise notice 'sla_worker_secret not set; skipping';
    return;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
end;
$$;
revoke all on function public.run_daily_sales_inbox() from public;
grant execute on function public.run_daily_sales_inbox() to service_role;

do $$ begin
  if not exists (select 1 from cron.job where jobname = 'karnaf_daily_sales_inbox') then
    -- 05:00 UTC → 08:00 IL in summer (DST), 07:00 IL in winter.
    -- Adjust via cron.schedule_in_database if Almog wants exactly 08:00
    -- year-round; PostgreSQL pg_cron does not natively respect TZ.
    perform cron.schedule('karnaf_daily_sales_inbox', '0 5 * * *',
      $cmd$ select public.run_daily_sales_inbox(); $cmd$);
  end if;
end $$;
