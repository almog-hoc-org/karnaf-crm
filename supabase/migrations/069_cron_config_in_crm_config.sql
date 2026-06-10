-- 069_cron_config_in_crm_config.sql
--
-- The cron runner functions (run_automation_tick from 066,
-- run_daily_sales_inbox from 056) read their target URL via
-- current_setting('app.x', true). That GUC pattern requires
-- ALTER DATABASE perms which the managed Supabase Postgres
-- doesn't grant — so the URLs were never actually configured
-- and both jobs no-op'd silently every tick.
--
-- This migration switches both runners to read from public.crm_config
-- (the existing key/value table, settable from the SQL editor by
-- staff) and seeds the URLs. Vault secrets keep working as-is.
--
-- After deploy:
--   * automation-tick fires every 10 min
--   * daily-sales-inbox fires daily at 05:00 UTC
-- Edit the URL via crm_config without a deploy:
--   update crm_config
--      set config_value = jsonb_build_object('url', '<new>')
--    where config_key = 'cron_automation_tick_url';

-- Seed the URLs. The Supabase project URL is hard-coded — if Almog
-- ever rebrands the domain, edit the row, no migration needed.
insert into public.crm_config (config_key, config_value)
values
  ('cron_automation_tick_url',
   jsonb_build_object('url', 'https://svkzkpgccahwmyflobvn.supabase.co/functions/v1/automation-tick')),
  ('cron_daily_sales_inbox_url',
   jsonb_build_object('url', 'https://svkzkpgccahwmyflobvn.supabase.co/functions/v1/daily-sales-inbox'))
on conflict (config_key) do update set config_value = excluded.config_value;

-- ─────────────────────────────────────────────────────────────────────
-- Replace run_automation_tick to read crm_config + vault.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.run_automation_tick() returns void
language plpgsql security definer set search_path = public, extensions, vault as $$
declare
  v_url text;
  v_secret text;
begin
  -- URL from crm_config (admin-editable; no deploy needed).
  select config_value ->> 'url' into v_url
    from public.crm_config where config_key = 'cron_automation_tick_url';
  -- Secret from vault (encrypted at rest).
  begin
    select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'automation_tick_secret' limit 1;
  exception when others then v_secret := null; end;

  if v_url is null or v_url = '' then
    raise notice 'cron_automation_tick_url not set in crm_config; skipping';
    return;
  end if;
  if v_secret is null then
    raise notice 'automation_tick_secret not set in vault; skipping';
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

-- ─────────────────────────────────────────────────────────────────────
-- Same treatment for run_daily_sales_inbox. Keeps the existing vault
-- secret name (`sla_worker_secret`) since the daily-sales-inbox edge
-- fn already authenticates with it.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.run_daily_sales_inbox() returns void
language plpgsql security definer set search_path = public, extensions, vault as $$
declare
  v_url text;
  v_secret text;
begin
  select config_value ->> 'url' into v_url
    from public.crm_config where config_key = 'cron_daily_sales_inbox_url';
  begin
    select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'sla_worker_secret' limit 1;
  exception when others then v_secret := null; end;

  if v_url is null or v_url = '' then
    raise notice 'cron_daily_sales_inbox_url not set in crm_config; skipping';
    return;
  end if;
  if v_secret is null then
    raise notice 'sla_worker_secret not set in vault; skipping';
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
