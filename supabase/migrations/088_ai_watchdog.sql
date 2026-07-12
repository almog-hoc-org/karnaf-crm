-- 088_ai_watchdog.sql
--
-- Recovered 2026-07-09 from production's
-- supabase_migrations.schema_migrations (the file was applied to
-- prod but never committed). Statements are verbatim as recorded
-- by the Supabase CLI at apply time.

-- 088_ai_watchdog.sql
--
-- Guardrail for the lead journey: if an inbound WhatsApp message lands and
-- no outbound follows quickly, or if the AI provider is disabled, create an
-- operational queue item and a repair task. The edge function also emits a
-- Telegram alert when alert secrets are configured.

insert into public.crm_config (config_key, config_value)
values
  ('cron_ai_watchdog_url',
   jsonb_build_object('url', 'https://svkzkpgccahwmyflobvn.supabase.co/functions/v1/ai-watchdog'))
on conflict (config_key) do update set config_value = excluded.config_value;

create or replace function public.run_ai_watchdog() returns void
language plpgsql security definer set search_path = public, extensions, vault as $$
declare
  v_url text;
  v_secret text;
begin
  select config_value ->> 'url' into v_url
    from public.crm_config where config_key = 'cron_ai_watchdog_url';

  begin
    select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'sla_worker_secret' limit 1;
  exception when others then v_secret := null; end;

  if v_url is null or v_url = '' then
    raise notice 'cron_ai_watchdog_url not set in crm_config; skipping';
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

revoke all on function public.run_ai_watchdog() from public;

grant execute on function public.run_ai_watchdog() to service_role;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'karnaf_ai_watchdog') then
    perform cron.schedule('karnaf_ai_watchdog', '*/5 * * * *', $cmd$ select public.run_ai_watchdog(); $cmd$);
  end if;
end $$;
