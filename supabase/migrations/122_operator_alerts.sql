-- 122_operator_alerts.sql
--
-- Ledger for alerts sent to the operator (not to leads). Three jobs:
--
--   1. Throttling. Every worker that could alert now asks "did I already
--      say this recently?" before sending. Before this, ai-watchdog sent a
--      `critical` every 5 minutes for as long as one lead stayed stuck —
--      288 identical messages a day — and sla-worker another 144. An alert
--      channel that noisy is one nobody reads.
--   2. A watermark for the hourly digest, so it can send "what is new since
--      the last digest" and stay silent when the answer is nothing.
--   3. An audit trail: which channels actually accepted each alert. When
--      the operator says "I never got anything", this table answers whether
--      we tried, and what the provider said.

create table if not exists operator_alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  -- Identity of the *thing* being alerted about (e.g. 'inbound:<lead_id>').
  -- Throttling and dedup key off this, not off the message text.
  dedupe_key text not null,
  severity text not null default 'info',
  title text not null,
  body text,
  -- {"whatsapp": {"ok": true, "id": "wamid…"}, "email": {"ok": false, "error": "…"}}
  channel_results jsonb not null default '{}'::jsonb,
  -- True when at least one channel accepted it. A row with false means the
  -- alert was composed and every channel refused — the case that used to be
  -- completely invisible.
  delivered boolean not null default false,
  correlation_id text,
  created_at timestamptz not null default now()
);

-- The throttle lookup: newest row for a dedupe_key.
create index if not exists operator_alerts_dedupe_idx
  on operator_alerts (dedupe_key, created_at desc);

-- The digest watermark and the ops view: newest row of a kind.
create index if not exists operator_alerts_kind_idx
  on operator_alerts (kind, created_at desc);

alter table operator_alerts enable row level security;

-- Service role writes; owner/admin read for the diagnostics screen. No
-- policy for anyone else — these can carry lead names and phone numbers.
drop policy if exists operator_alerts_admin_read on operator_alerts;
create policy operator_alerts_admin_read on operator_alerts
  for select to authenticated
  using (public.has_role(array['owner','admin']::user_role[]));

-- Keep the ledger from growing without bound; 90 days is well past any
-- question anyone asks of it.
create or replace function purge_operator_alerts() returns void
language sql security definer set search_path = public as $$
  delete from operator_alerts where created_at < now() - interval '90 days';
$$;

-- ── Hourly digest cron ───────────────────────────────────────────────
-- Same shape as run_template_sync (098): vault secret, hardcoded URL
-- fallback, skip quietly when unconfigured. The function itself decides
-- whether there is anything worth sending — an hour with no new inbound,
-- no new lead and no new queue item produces no message at all.
create or replace function public.run_operator_digest()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_url text := current_setting('app.operator_digest_url', true);
  v_secret text;
begin
  begin
    select decrypted_secret into v_secret
    from vault.decrypted_secrets
    where name = 'sla_worker_secret'
    order by created_at desc
    limit 1;
  exception when others then
    v_secret := null;
  end;

  if v_url is null or v_url = '' then
    v_url := 'https://svkzkpgccahwmyflobvn.supabase.co/functions/v1/operator-digest';
  end if;

  if v_secret is null or v_secret = '' then
    raise notice 'sla_worker_secret not set in vault; skipping operator digest';
    return;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('trigger', 'cron')
  );
end;
$$;

revoke all on function public.run_operator_digest() from public;
grant execute on function public.run_operator_digest() to service_role;

do $$ begin
  if not exists (select 1 from cron.job where jobname = 'karnaf_operator_digest') then
    -- :20 rather than :00 so it does not queue behind the other top-of-hour jobs.
    perform cron.schedule('karnaf_operator_digest', '20 * * * *',
      $cmd$ select public.run_operator_digest(); $cmd$);
  end if;
  if not exists (select 1 from cron.job where jobname = 'karnaf_purge_operator_alerts') then
    perform cron.schedule('karnaf_purge_operator_alerts', '50 2 * * *',
      $cmd$ select public.purge_operator_alerts(); $cmd$);
  end if;
end $$;
