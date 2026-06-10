-- 066_automation_tick_cron.sql
--
-- Tier 4.A.3 — schedule the engine's time-elapsed tick.
--
-- Same pattern as 056_daily_sales_inbox_cron: a SECURITY DEFINER
-- runner reads URL + secret from session config / vault, calls the
-- edge fn, returns. pg_cron schedules the runner every 10 minutes.
--
-- 10 minutes is the right balance for "time.elapsed" rules: B5
-- triggers at 24h, B6 at 48h, B8 at 14d. A 10-minute window means
-- the rule fires within ~5 minutes of its true threshold (acceptable
-- for nurture cadence) and the worker scans ≤ ~150 leads per tick
-- given Karnaf's current volume — well under the MAX_LEADS_PER_TICK
-- cap inside the function.
--
-- To enable in prod:
--   1. Set app.automation_tick_url via Supabase project settings.
--   2. Set vault.automation_tick_secret to match the function's
--      AUTOMATION_TICK_SECRET env var.
-- Until both are set, the runner exits with a NOTICE — no harm done.

create or replace function public.run_automation_tick() returns void
language plpgsql security definer set search_path = public, extensions, vault as $$
declare
  v_url text := current_setting('app.automation_tick_url', true);
  v_secret text;
begin
  begin
    select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'automation_tick_secret' limit 1;
  exception when others then v_secret := null; end;

  if v_url is null or v_url = '' then
    raise notice 'automation_tick_url not set; skipping';
    return;
  end if;
  if v_secret is null then
    raise notice 'automation_tick_secret not set; skipping';
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
revoke all on function public.run_automation_tick() from public;
grant execute on function public.run_automation_tick() to service_role;

do $$ begin
  if not exists (select 1 from cron.job where jobname = 'karnaf_automation_tick') then
    -- Every 10 minutes, around the clock. Engine itself reads
    -- automation_rules at each tick, so a no-rules deployment is
    -- a near-free early-exit inside the function.
    perform cron.schedule('karnaf_automation_tick', '*/10 * * * *',
      $cmd$ select public.run_automation_tick(); $cmd$);
  end if;
end $$;
