-- 085_broadcasts.sql
--
-- Campaign broadcasts + the webinar-launch confirmation rule.
--
-- Ships four things:
--   1. outbound_dispatch.priority — so real-time bot traffic (priority 0)
--      always drains ahead of a large broadcast (priority 10). A broadcast
--      must never starve the conversational bot.
--   2. broadcasts + broadcast_recipients — the module's storage. One row
--      per broadcast; one recipient row per (broadcast, lead) with a unique
--      constraint for idempotent materialisation.
--   3. engine_template_sends — a once-ledger so `send_template` with
--      once:true fires at most once per (lead, key).
--   4. campaign_webinar_launch_confirm — the lead.created engine rule that
--      sends the "נרשמת לוובינר" WhatsApp confirmation, plus the
--      run_broadcast_dispatch cron that pokes the broadcast-dispatch worker.
--
-- All additive. Nothing here changes existing bot behaviour.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Dispatch priority. Lower number = drained first. Default 0 keeps
--    every existing enqueue (bot replies, manual replies) at top priority;
--    the broadcast worker enqueues at 10 so it always yields to the bot.
-- ─────────────────────────────────────────────────────────────────────
alter table public.outbound_dispatch
  add column if not exists priority integer not null default 0;

create index if not exists idx_outbound_dispatch_due_priority
  on public.outbound_dispatch (priority, next_attempt_at)
  where status = 'pending';

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
    -- priority first (bot=0 before broadcast=10), then oldest-due.
    order by od.priority asc, od.next_attempt_at asc
    limit p_batch_size
    for update skip locked
  )
  update public.outbound_dispatch od
     set status = 'in_flight',
         attempts = od.attempts + 1
   where od.id in (select claimed.id from claimed)
  returning od.id, od.lead_id, od.conversation_id, od.payload, od.attempts, od.correlation_id;
end;
$$;

revoke all on function public.claim_outbound_dispatch(integer) from public;
grant execute on function public.claim_outbound_dispatch(integer) to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 2. once-ledger for engine send_template.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.engine_template_sends (
  id             uuid primary key default gen_random_uuid(),
  lead_id        uuid not null references public.leads(id) on delete cascade,
  -- Arbitrary key scoping the once-ness. Defaults to '<channel>:<key>'
  -- from the action, but a rule can pass its own once_key.
  once_key       text not null,
  correlation_id text,
  created_at     timestamptz not null default now(),
  unique (lead_id, once_key)
);

create index if not exists idx_engine_template_sends_lead
  on public.engine_template_sends (lead_id);

alter table public.engine_template_sends enable row level security;
grant select, insert, update, delete on public.engine_template_sends to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Broadcasts.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.broadcasts (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  channel         text not null default 'whatsapp' check (channel in ('whatsapp', 'email')),
  -- Optional local preview template (message_templates.key). The customer
  -- receives the Meta template text; body_snapshot is the CRM-side preview.
  template_key    text,
  -- Approved Meta template descriptor: { name, lang?, params? }. Required
  -- for the whatsapp channel (cold audience → template send).
  meta_template   jsonb,
  body_snapshot   text,
  -- Segment selector resolved by broadcast-segment.ts:
  --   { source?, source_campaign?, primary_track?, product_interest? }
  segment         jsonb not null default '{}'::jsonb,
  scheduled_at    timestamptz,
  status          text not null default 'draft'
                  check (status in ('draft', 'scheduled', 'sending', 'sent', 'canceled', 'failed')),
  recipient_count integer not null default 0,
  sent_count      integer not null default 0,
  skipped_count   integer not null default 0,
  failed_count    integer not null default 0,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sent_at         timestamptz
);

create index if not exists idx_broadcasts_status_scheduled
  on public.broadcasts (status, scheduled_at);

alter table public.broadcasts enable row level security;
drop policy if exists broadcasts_staff_all on public.broadcasts;
create policy broadcasts_staff_all on public.broadcasts
  for all to authenticated
  using (public.is_active_staff())
  with check (public.is_active_staff());
grant select, insert, update, delete on public.broadcasts to service_role;

drop trigger if exists trg_broadcasts_updated_at on public.broadcasts;
create trigger trg_broadcasts_updated_at
  before update on public.broadcasts
  for each row execute function public.set_updated_at();

create table if not exists public.broadcast_recipients (
  id                  uuid primary key default gen_random_uuid(),
  broadcast_id        uuid not null references public.broadcasts(id) on delete cascade,
  lead_id             uuid not null references public.leads(id) on delete cascade,
  status              text not null default 'pending'
                      check (status in ('pending', 'queued', 'sent', 'skipped', 'failed')),
  dispatch_id         uuid,
  message_id          uuid references public.messages(id) on delete set null,
  provider_message_id text,
  error               text,
  sent_at             timestamptz,
  created_at          timestamptz not null default now(),
  unique (broadcast_id, lead_id)
);

create index if not exists idx_broadcast_recipients_broadcast
  on public.broadcast_recipients (broadcast_id, status);

alter table public.broadcast_recipients enable row level security;
drop policy if exists broadcast_recipients_staff_all on public.broadcast_recipients;
create policy broadcast_recipients_staff_all on public.broadcast_recipients
  for all to authenticated
  using (public.is_active_staff())
  with check (public.is_active_staff());
grant select, insert, update, delete on public.broadcast_recipients to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 4a. Webinar-launch confirmation template (preview) + engine rule.
-- ─────────────────────────────────────────────────────────────────────
-- Preview copy only — the customer receives the Meta-approved
-- `webinar_launch_confirm` template (0 params). Keep the two texts aligned.
insert into public.message_templates (key, channel, name_he, body, status, tags, metadata)
values (
  'webinar_launch_confirm', 'whatsapp', 'אישור הרשמה לוובינר השקה',
  'היי! נרשמת בהצלחה לוובינר ההשקה של "הדרך לדירה". נשלח לך קישור וכל הפרטים לקראת המפגש. נתראה! 🏠',
  'active', array['webinar', 'launch'],
  jsonb_build_object('meta_template', 'webinar_launch_confirm', 'meta_params', 0)
)
on conflict (channel, key) do nothing;

insert into public.automation_rules
  (code, name_he, description, trigger_event, category, source, enabled, conditions, actions, implementation_ref)
values
  ('campaign_webinar_launch_confirm',
    'קמפיין: אישור הרשמה לוובינר השקה',
    'ליד שנרשם לוובינר ההשקה (source_campaign=launch_webinar_2026) מקבל הודעת אישור בוואטסאפ פעם אחת. שולח את תבנית Meta המאושרת webinar_launch_confirm (0 משתנים), מכבד DNC.',
    'lead.created', 'campaign', 'engine', true,
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
    ),
    'engine rule — leads-intake lead.created + dispatch-outbound meta_template'
  )
on conflict (code) do update set
  name_he = excluded.name_he,
  description = excluded.description,
  trigger_event = excluded.trigger_event,
  source = excluded.source,
  enabled = excluded.enabled,
  conditions = excluded.conditions,
  actions = excluded.actions,
  implementation_ref = excluded.implementation_ref;

-- ─────────────────────────────────────────────────────────────────────
-- 4b. broadcast-dispatch cron poke. Same shape as run_outbound_dispatch:
--     no-ops silently until app.broadcast_dispatch_url + the vault secret
--     `broadcast_dispatch_secret` are configured (post-deploy step).
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.run_broadcast_dispatch()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_url text := current_setting('app.broadcast_dispatch_url', true);
  v_secret text;
begin
  begin
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'broadcast_dispatch_secret' limit 1;
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

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'karnaf_broadcast_dispatch') then
    perform cron.schedule('karnaf_broadcast_dispatch', '* * * * *', $cmd$ select public.run_broadcast_dispatch(); $cmd$);
  end if;
end $$;
