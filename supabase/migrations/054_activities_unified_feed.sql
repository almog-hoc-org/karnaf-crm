-- 054_activities_unified_feed.sql
--
-- Tier 0.A of the v4 redesign: one unified `activities` table that absorbs
-- messages + lead_events + lead_tasks + work_queue. The Universal Record
-- Screen (spec § ג') needs a single chronological feed instead of four
-- separate panes.
--
-- Strategy: DB-level dual-write via triggers. Every INSERT/UPDATE on the
-- four source tables is mirrored to `activities` automatically — no
-- application code needs to remember to call a helper. Once the new
-- frontend has been running stable for a release, the source tables get
-- dropped (Tier 1).
--
-- Backwards-compat: source tables stay as-is. No edge function breaks.
-- Reads can choose: query a source table directly (legacy), or query
-- activities (new). lead-detail returns BOTH for one release so we can
-- A/B verify before cutover.

create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),

  -- Required relationships
  contact_id uuid not null references public.leads(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  activity_type text not null,
  actor_type text not null,

  -- Optional relationships
  conversation_id uuid references public.conversations(id) on delete set null,
  deal_id uuid references public.deals(id) on delete set null,
  meeting_id uuid references public.meetings(id) on delete set null,
  actor_user_id uuid references public.profiles(id) on delete set null,

  -- Display content
  title text,
  body text,

  -- For task / queue-item / call-log style activities
  status text,
  priority_level int,
  due_at timestamptz,
  completed_at timestamptz,

  -- For message activities
  direction text,

  -- Backfill / sync provenance — lets us idempotently mirror source rows
  source_table text not null,
  source_id uuid,
  payload jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);

-- The activity feed is read 99% of the time by (contact_id, occurred_at desc).
-- A composite descending index lets the Universal Record Screen page through
-- a contact's history without sorting.
create index if not exists idx_activities_contact_occurred
  on public.activities(contact_id, occurred_at desc);

-- Deals get their own scoped index for the deal-specific timeline (Tier 1).
create index if not exists idx_activities_deal_occurred
  on public.activities(deal_id, occurred_at desc) where deal_id is not null;

-- "What's open right now for this contact" — drives the next-action chips.
create index if not exists idx_activities_open_status
  on public.activities(contact_id, status) where status in ('open', 'pending', 'claimed');

-- Filter by kind (messages-only feed, tasks-only, etc.).
create index if not exists idx_activities_type
  on public.activities(activity_type, occurred_at desc);

-- Idempotency for the mirror triggers — replaying the trigger updates in place
-- instead of inserting duplicates.
create unique index if not exists uniq_activities_source
  on public.activities(source_table, source_id) where source_id is not null;

alter table public.activities enable row level security;

drop policy if exists activities_staff_read on public.activities;
create policy activities_staff_read on public.activities
  for select to authenticated using (public.is_active_staff());

drop policy if exists activities_staff_modify on public.activities;
create policy activities_staff_modify on public.activities
  for all to authenticated using (public.is_active_staff()) with check (public.is_active_staff());

grant select, insert, update, delete on public.activities to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- Trigger functions: mirror each source table into activities.
--
-- All four functions use `on conflict (source_table, source_id) do update`
-- so a re-fire (e.g. when the source row is updated) refreshes the mirror
-- instead of duplicating. This makes the triggers safe to enable on a
-- backfilled table.
-- ─────────────────────────────────────────────────────────────────────

create or replace function public.sync_message_to_activity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.activities (
    contact_id, occurred_at, activity_type, actor_type, conversation_id,
    title, body, direction, source_table, source_id, payload
  ) values (
    NEW.lead_id, NEW.created_at, 'message', NEW.sender_type, NEW.conversation_id,
    NEW.sender_name, NEW.content_text, NEW.direction, 'messages', NEW.id,
    jsonb_build_object(
      'provider_message_id', NEW.provider_message_id,
      'provider_status', NEW.provider_status,
      'message_type', NEW.message_type,
      'media_url', NEW.media_url,
      'media_type', NEW.media_type,
      'sent_at', NEW.sent_at,
      'delivered_at', NEW.delivered_at,
      'read_at', NEW.read_at,
      'ai_intent_classification', NEW.ai_intent_classification,
      'ai_sentiment_signal', NEW.ai_sentiment_signal
    )
  )
  on conflict (source_table, source_id) do update set
    body = excluded.body,
    payload = excluded.payload,
    direction = excluded.direction;
  return NEW;
end;
$$;

create or replace function public.sync_lead_event_to_activity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.activities (
    contact_id, occurred_at, activity_type, actor_type, actor_user_id,
    conversation_id, title, source_table, source_id, payload
  ) values (
    NEW.lead_id, NEW.created_at, 'event', NEW.actor_type, NEW.actor_id,
    NEW.conversation_id, NEW.event_type, 'lead_events', NEW.id, NEW.event_payload
  )
  on conflict (source_table, source_id) do update set
    title = excluded.title,
    payload = excluded.payload;
  return NEW;
end;
$$;

create or replace function public.sync_lead_task_to_activity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.activities (
    contact_id, occurred_at, activity_type, actor_type, actor_user_id,
    conversation_id, title, body, status, priority_level, due_at, completed_at,
    source_table, source_id, payload
  ) values (
    NEW.lead_id, NEW.created_at, 'task', NEW.owner_type, NEW.owner_user_id,
    NEW.conversation_id, NEW.title, NEW.description, NEW.task_status,
    NEW.priority_level, NEW.due_at, NEW.completed_at, 'lead_tasks', NEW.id,
    coalesce(NEW.payload_json, '{}'::jsonb) || jsonb_build_object(
      'task_type', NEW.task_type, 'completion_note', NEW.completion_note
    )
  )
  on conflict (source_table, source_id) do update set
    title = excluded.title,
    body = excluded.body,
    status = excluded.status,
    priority_level = excluded.priority_level,
    due_at = excluded.due_at,
    completed_at = excluded.completed_at,
    payload = excluded.payload;
  return NEW;
end;
$$;

create or replace function public.sync_work_queue_to_activity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.activities (
    contact_id, occurred_at, activity_type, actor_type, actor_user_id,
    title, body, status, priority_level, due_at, completed_at,
    source_table, source_id, payload
  ) values (
    NEW.lead_id, NEW.created_at, 'queue_item', NEW.created_by_actor_type,
    NEW.assigned_to_user_id, NEW.queue_type, coalesce(NEW.queue_summary, NEW.reason),
    NEW.status, NEW.priority_level, NEW.due_at, NEW.resolved_at,
    'work_queue', NEW.id,
    coalesce(NEW.payload_json, '{}'::jsonb) || jsonb_build_object(
      'queue_type', NEW.queue_type, 'reason', NEW.reason, 'resolution_note', NEW.resolution_note
    )
  )
  on conflict (source_table, source_id) do update set
    title = excluded.title,
    body = excluded.body,
    status = excluded.status,
    priority_level = excluded.priority_level,
    due_at = excluded.due_at,
    completed_at = excluded.completed_at,
    payload = excluded.payload;
  return NEW;
end;
$$;

drop trigger if exists trg_sync_message_to_activity on public.messages;
create trigger trg_sync_message_to_activity
  after insert or update on public.messages
  for each row execute function public.sync_message_to_activity();

drop trigger if exists trg_sync_lead_event_to_activity on public.lead_events;
create trigger trg_sync_lead_event_to_activity
  after insert or update on public.lead_events
  for each row execute function public.sync_lead_event_to_activity();

drop trigger if exists trg_sync_lead_task_to_activity on public.lead_tasks;
create trigger trg_sync_lead_task_to_activity
  after insert or update on public.lead_tasks
  for each row execute function public.sync_lead_task_to_activity();

drop trigger if exists trg_sync_work_queue_to_activity on public.work_queue;
create trigger trg_sync_work_queue_to_activity
  after insert or update on public.work_queue
  for each row execute function public.sync_work_queue_to_activity();

-- ─────────────────────────────────────────────────────────────────────
-- One-time backfill. Idempotent via the (source_table, source_id) unique
-- index — re-running this migration on a partially-backfilled DB is safe.
-- ─────────────────────────────────────────────────────────────────────

insert into public.activities (
  contact_id, occurred_at, activity_type, actor_type, conversation_id,
  title, body, direction, source_table, source_id, payload
)
select
  m.lead_id, m.created_at, 'message', m.sender_type, m.conversation_id,
  m.sender_name, m.content_text, m.direction, 'messages', m.id,
  jsonb_build_object(
    'provider_message_id', m.provider_message_id,
    'provider_status', m.provider_status,
    'message_type', m.message_type,
    'media_url', m.media_url,
    'media_type', m.media_type,
    'sent_at', m.sent_at,
    'delivered_at', m.delivered_at,
    'read_at', m.read_at,
    'ai_intent_classification', m.ai_intent_classification,
    'ai_sentiment_signal', m.ai_sentiment_signal
  )
from public.messages m
on conflict (source_table, source_id) do nothing;

insert into public.activities (
  contact_id, occurred_at, activity_type, actor_type, actor_user_id,
  conversation_id, title, source_table, source_id, payload
)
select
  e.lead_id, e.created_at, 'event', e.actor_type, e.actor_id,
  e.conversation_id, e.event_type, 'lead_events', e.id, e.event_payload
from public.lead_events e
on conflict (source_table, source_id) do nothing;

insert into public.activities (
  contact_id, occurred_at, activity_type, actor_type, actor_user_id,
  conversation_id, title, body, status, priority_level, due_at, completed_at,
  source_table, source_id, payload
)
select
  t.lead_id, t.created_at, 'task', t.owner_type, t.owner_user_id,
  t.conversation_id, t.title, t.description, t.task_status, t.priority_level,
  t.due_at, t.completed_at, 'lead_tasks', t.id,
  coalesce(t.payload_json, '{}'::jsonb) || jsonb_build_object(
    'task_type', t.task_type, 'completion_note', t.completion_note
  )
from public.lead_tasks t
on conflict (source_table, source_id) do nothing;

insert into public.activities (
  contact_id, occurred_at, activity_type, actor_type, actor_user_id,
  title, body, status, priority_level, due_at, completed_at,
  source_table, source_id, payload
)
select
  w.lead_id, w.created_at, 'queue_item', w.created_by_actor_type,
  w.assigned_to_user_id, w.queue_type, coalesce(w.queue_summary, w.reason),
  w.status, w.priority_level, w.due_at, w.resolved_at,
  'work_queue', w.id,
  coalesce(w.payload_json, '{}'::jsonb) || jsonb_build_object(
    'queue_type', w.queue_type, 'reason', w.reason, 'resolution_note', w.resolution_note
  )
from public.work_queue w
on conflict (source_table, source_id) do nothing;
