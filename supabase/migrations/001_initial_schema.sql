-- Karnaf CRM Core initial schema skeleton
-- This is a starting migration scaffold derived from the schema spec.
-- The developer should complete and validate it before production use.

create extension if not exists pgcrypto;

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  full_name text,
  phone text,
  email text,
  source text not null,
  source_detail text,
  source_campaign text,
  webinar_name text,
  lead_magnet_name text,
  intake_channel text,
  external_source text,
  external_id text,
  city text,
  lead_status text not null default 'new',
  lead_heat text not null default 'cool',
  lead_fit text,
  readiness_level text,
  decision_context text,
  partner_involved boolean not null default false,
  partner_alignment_state text,
  requested_phone_call boolean not null default false,
  do_not_contact boolean not null default false,
  removed_by_request boolean not null default false,
  human_owner_id uuid,
  ownership_mode text not null default 'ai_active',
  ai_owner_state text,
  lead_score integer not null default 0,
  main_blocker text,
  pain_point_summary text,
  goal_summary text,
  conversation_summary text,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_human_touch_at timestamptz,
  last_ai_touch_at timestamptz,
  next_action_type text,
  next_action_due_at timestamptz,
  last_checkout_link_sent_at timestamptz,
  checkout_state text,
  payment_status text,
  payment_reference text,
  payment_completed_at timestamptz,
  won_at timestamptz,
  lost_at timestamptz,
  lost_reason text,
  notes_internal text,
  raw_import_snapshot jsonb not null default '{}'::jsonb
);

create index if not exists idx_leads_phone on leads(phone);
create index if not exists idx_leads_email on leads(email);
create index if not exists idx_leads_status on leads(lead_status);
create index if not exists idx_leads_next_action_due_at on leads(next_action_due_at);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  channel text not null,
  channel_thread_id text,
  ownership_mode text not null default 'ai_active',
  current_handler_id uuid,
  is_open boolean not null default true,
  started_at timestamptz not null default now(),
  last_activity_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_summary text,
  provider_name text,
  provider_thread_ref text,
  metadata_json jsonb not null default '{}'::jsonb
);

create index if not exists idx_conversations_lead_channel on conversations(lead_id, channel);
create index if not exists idx_conversations_last_activity_at on conversations(last_activity_at);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  provider_message_id text,
  sender_type text not null,
  sender_name text,
  direction text not null,
  message_type text not null,
  content_text text,
  media_url text,
  media_type text,
  provider_status text,
  provider_error text,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  ai_intent_classification text,
  ai_sentiment_signal text,
  requires_review boolean not null default false,
  raw_payload jsonb not null default '{}'::jsonb
);

create index if not exists idx_messages_conversation_created_at on messages(conversation_id, created_at);
create index if not exists idx_messages_lead_created_at on messages(lead_id, created_at);

create table if not exists lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  event_type text not null,
  actor_type text not null,
  actor_id uuid,
  event_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_lead_events_lead_created_at on lead_events(lead_id, created_at);
create index if not exists idx_lead_events_type on lead_events(event_type);

create table if not exists work_queue (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  queue_type text not null,
  priority_level integer not null default 3,
  status text not null default 'pending',
  reason text,
  queue_summary text,
  assigned_to_user_id uuid,
  created_by_actor_type text not null,
  due_at timestamptz,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_note text,
  payload_json jsonb not null default '{}'::jsonb
);

create index if not exists idx_work_queue_status_due_at on work_queue(status, due_at);
create index if not exists idx_work_queue_type_status on work_queue(queue_type, status);

create table if not exists lead_tasks (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  task_type text not null,
  task_status text not null default 'open',
  owner_type text not null,
  owner_user_id uuid,
  title text not null,
  description text,
  priority_level integer not null default 3,
  due_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  completion_note text,
  payload_json jsonb not null default '{}'::jsonb
);

create index if not exists idx_lead_tasks_status_due_at on lead_tasks(task_status, due_at);

create table if not exists payment_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete set null,
  external_order_id text,
  external_customer_ref text,
  payment_provider text not null,
  product_code text,
  payment_status text not null,
  amount numeric,
  currency text,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists integration_logs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  status text not null,
  lead_id uuid references leads(id) on delete set null,
  request_data jsonb,
  response_data jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists ai_decisions (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  model_name text not null,
  prompt_version text,
  playbook_name text,
  input_context_json jsonb not null default '{}'::jsonb,
  raw_output_json jsonb not null default '{}'::jsonb,
  validated_output_json jsonb not null default '{}'::jsonb,
  execution_status text not null,
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists crm_config (
  id uuid primary key default gen_random_uuid(),
  config_key text not null unique,
  config_value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by_user_id uuid
);
