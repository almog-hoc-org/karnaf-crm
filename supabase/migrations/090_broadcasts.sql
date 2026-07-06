-- 085_broadcasts.sql
--
-- Broadcast / bulk-messaging module (הודעות תפוצה).
--
-- Lets an operator send one message to a segment of leads (by source,
-- source_campaign, primary_track, product_interest), scheduled to an
-- absolute time, over WhatsApp (phase 1) or email (phase 2), with
-- per-recipient analytics.
--
-- Delivery reuses the existing, battle-tested outbound_dispatch queue +
-- dispatch-outbound worker (DNC guard, retries, 24h-window handling,
-- Meta-template-by-name send). This migration adds:
--   * broadcasts + broadcast_recipients tables
--   * outbound_dispatch.priority so real-time bot traffic always drains
--     before a large broadcast — the "won't block the bot" guarantee
--   * a paced cron runner (run_broadcast_dispatch) hitting the
--     broadcast-dispatch edge function every minute
--   * two message_templates rows + one engine rule for the webinar
--     launch campaign
--
-- Additive only. Nothing existing changes behaviour unless a row opts in
-- (priority defaults to 0 = today's behaviour).

-- ─────────────────────────────────────────────────────────────────────
-- 1. broadcasts
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.broadcasts (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  channel          text not null default 'whatsapp' check (channel in ('whatsapp', 'email')),
  -- message_templates.key of the body to send. For WhatsApp cold sends
  -- this must be a Meta-approved template (see meta_template below).
  template_key     text,
  -- Meta-approved template descriptor for WhatsApp cold-audience sends:
  -- { name, lang, params: [] }. Null for in-window / email sends.
  meta_template    jsonb,
  -- Frozen copy of the rendered body at schedule time, for the audit
  -- trail + analytics preview even if the template later changes.
  body_snapshot    text,
  -- Segment filter — matched against leads in broadcast-dispatch.
  -- Shape: { source?, source_campaign?, primary_track?, product_interest? }.
  segment          jsonb not null default '{}'::jsonb,
  scheduled_at     timestamptz,
  status           text not null default 'draft'
                   check (status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed')),
  recipients_count integer not null default 0,
  sent_count       integer not null default 0,
  failed_count     integer not null default 0,
  skipped_count    integer not null default 0,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_broadcasts_status_due
  on public.broadcasts (status, scheduled_at) where status = 'scheduled';

drop trigger if exists trg_broadcasts_updated_at on public.broadcasts;
create trigger trg_broadcasts_updated_at
  before update on public.broadcasts
  for each row execute function public.set_updated_at();

alter table public.broadcasts enable row level security;
drop policy if exists broadcasts_staff_all on public.broadcasts;
create policy broadcasts_staff_all on public.broadcasts
  for all to authenticated
  using (public.is_active_staff())
  with check (public.is_active_staff());
grant select, insert, update, delete on public.broadcasts to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 2. broadcast_recipients — one row per (broadcast, lead)
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.broadcast_recipients (
  id            uuid primary key default gen_random_uuid(),
  broadcast_id  uuid not null references public.broadcasts(id) on delete cascade,
  lead_id       uuid not null references public.leads(id) on delete cascade,
  status        text not null default 'pending'
                check (status in ('pending', 'enqueued', 'sent', 'delivered', 'read', 'failed', 'skipped')),
  dispatch_id   uuid references public.outbound_dispatch(id) on delete set null,
  message_id    uuid references public.messages(id) on delete set null,
  sent_at       timestamptz,
  error         text,
  created_at    timestamptz not null default now(),
  -- Idempotency: a lead is enqueued at most once per broadcast, even if
  -- the runner re-runs or crashes mid-materialisation.
  unique (broadcast_id, lead_id)
);

create index if not exists idx_broadcast_recipients_broadcast
  on public.broadcast_recipients (broadcast_id, status);
create index if not exists idx_broadcast_recipients_message
  on public.broadcast_recipients (message_id) where message_id is not null;

alter table public.broadcast_recipients enable row level security;
drop policy if exists broadcast_recipients_staff_all on public.broadcast_recipients;
create policy broadcast_recipients_staff_all on public.broadcast_recipients
  for all to authenticated
  using (public.is_active_staff())
  with check (public.is_active_staff());
grant select, insert, update, delete on public.broadcast_recipients to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 3. outbound_dispatch priority — real-time bot traffic (priority 0)
--    always drains before broadcast traffic (priority > 0).
-- ─────────────────────────────────────────────────────────────────────
alter table public.outbound_dispatch
  add column if not exists priority integer not null default 0;

-- Recreate the claim RPC to order by priority first. Body is otherwise
-- identical to 036 — SKIP LOCKED batch claim.
create or replace function public.claim_outbound_dispatch(p_batch_size integer default 10)
returns table(
  id uuid,
  lead_id uuid,
  conversation_id uuid,
  payload jsonb,
  attempts integer,
  correlation_id text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    select od.id
    from public.outbound_dispatch od
    where od.status = 'pending'
      and od.next_attempt_at <= now()
    order by od.priority asc, od.next_attempt_at asc
    limit p_batch_size
    for update skip locked
  )
  update public.outbound_dispatch od
     set status = 'in_flight',
         attempts = od.attempts + 1
   where od.id in (select id from claimed)
  returning od.id, od.lead_id, od.conversation_id, od.payload, od.attempts, od.correlation_id;
end;
$$;
grant execute on function public.claim_outbound_dispatch(integer) to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 4. Cron runner for the broadcast-dispatch worker (every minute).
--    Same vault/session-config pattern as run_automation_tick — exits
--    with a NOTICE (no harm) until the URL + secret are configured.
--
--    To enable in prod:
--      1. Set app.broadcast_dispatch_url via project settings.
--      2. Set vault.broadcast_dispatch_secret to match the function's
--         BROADCAST_DISPATCH_SECRET env var.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.run_broadcast_dispatch() returns void
language plpgsql security definer set search_path = public, extensions, vault as $$
declare
  v_url text := current_setting('app.broadcast_dispatch_url', true);
  v_secret text;
begin
  begin
    select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'broadcast_dispatch_secret' limit 1;
  exception when others then v_secret := null; end;

  if v_url is null or v_url = '' then
    raise notice 'broadcast_dispatch_url not set; skipping';
    return;
  end if;
  if v_secret is null then
    raise notice 'broadcast_dispatch_secret not set; skipping';
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
revoke all on function public.run_broadcast_dispatch() from public;
grant execute on function public.run_broadcast_dispatch() to service_role;

do $$ begin
  if not exists (select 1 from cron.job where jobname = 'karnaf_broadcast_dispatch') then
    perform cron.schedule('karnaf_broadcast_dispatch', '* * * * *',
      $cmd$ select public.run_broadcast_dispatch(); $cmd$);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- 5. Campaign templates + engine rule — "הדרך לדירה" webinar launch.
--    The body text mirrors the Meta-approved template; the actual send
--    goes out via meta_template (name) so it passes Meta's cold-contact
--    rules. Almog approved webinar_launch_confirm + webinar_launch_reminder.
-- ─────────────────────────────────────────────────────────────────────
insert into public.message_templates (key, channel, name_he, description, body, variables_used, tags, status)
values
  ('webinar_launch_confirm', 'whatsapp',
   'אישור הרשמה לוובינר השקה',
   'נשלח אוטומטית לכל נרשם לוובינר ההשקה של "הדרך לדירה". תבנית Meta מאושרת בשם webinar_launch_confirm.',
   'קיבלנו את ההרשמה שלך לוובינר הקרוב, קישור לזום ישלח לך כאן ובמייל סמוך למפגש 💪🦏',
   array[]::text[], array['webinar', 'launch'], 'active'),
  ('webinar_launch_reminder', 'whatsapp',
   'תזכורת יום הוובינר',
   'תזכורת ביום המפגש עם קישור הזום. נשלחת כתפוצה מתוזמנת. תבנית Meta מאושרת בשם webinar_launch_reminder.',
   'תזכורת! הוובינר של "הדרך לדירה" קורה היום ב-20:30. נתראה שם 💪🦏',
   array[]::text[], array['webinar', 'launch'], 'active')
on conflict (key, channel) do nothing;

-- Engine rule: on every webinar-launch registration, send the WhatsApp
-- confirmation once. Segments on source_campaign (robust to the
-- all-subscribers Rav Messer webhook double-firing) with DNC guard.
insert into public.automation_rules
  (code, name_he, description, trigger_event, category, source, enabled, implementation_ref, conditions, actions)
values (
  'campaign_webinar_launch_confirm',
  'אישור הרשמה — וובינר השקה',
  'שולח וואטסאפ אישור הרשמה (תבנית Meta מאושרת) לכל נרשם לוובינר ההשקה, פעם אחת.',
  'lead.created',
  'nurture',
  'engine',
  true,
  'automation-engine + dispatch-outbound (meta_template path)',
  jsonb_build_object(
    'all', jsonb_build_array(
      jsonb_build_object('field', 'lead.source_campaign', 'op', 'eq', 'value', 'launch_webinar_2026'),
      jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false)
    )
  ),
  jsonb_build_array(
    jsonb_build_object(
      'type', 'send_template',
      'key', 'webinar_launch_confirm',
      'channel', 'whatsapp',
      'once', true,
      'meta_template', jsonb_build_object('name', 'webinar_launch_confirm', 'lang', 'he')
    )
  )
)
on conflict (code) do nothing;
