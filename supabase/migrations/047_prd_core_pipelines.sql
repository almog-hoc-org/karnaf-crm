-- PRD v1 core foundation: one CRM/contact record with multiple product pipelines.
-- Existing `leads` remains the unified Contact record. New entities are additive
-- so current WhatsApp/AI/operator workflows keep working.

alter table public.leads
  add column if not exists primary_track text,
  add column if not exists active_tracks text[] not null default '{}'::text[],
  add column if not exists interest_topic text,
  add column if not exists tags text[] not null default '{}'::text[],
  add column if not exists consent_whatsapp boolean,
  add column if not exists consent_email boolean,
  add column if not exists consent_updated_at timestamptz;

create index if not exists idx_leads_primary_track on public.leads(primary_track);
create index if not exists idx_leads_active_tracks on public.leads using gin(active_tracks);
create index if not exists idx_leads_tags on public.leads using gin(tags);

create table if not exists public.deals (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  track text not null check (track in ('program','presale','investor_mentorship')),
  stage text not null,
  value numeric,
  currency text not null default 'ILS',
  presale_project text,
  partner_name text,
  expected_close date,
  status text not null default 'open' check (status in ('open','won','lost','cancelled')),
  owner_user_id uuid references public.profiles(id) on delete set null,
  source text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists idx_deals_lead on public.deals(lead_id, created_at desc);
create index if not exists idx_deals_track_stage on public.deals(track, stage, status);
create index if not exists idx_deals_owner on public.deals(owner_user_id) where owner_user_id is not null;
create unique index if not exists uniq_deals_one_open_per_track on public.deals(lead_id, track) where status = 'open';

create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  deal_id uuid references public.deals(id) on delete set null,
  meeting_type text not null check (meeting_type in ('phone','zoom','office')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  assigned_to_user_id uuid references public.profiles(id) on delete set null,
  status text not null default 'scheduled' check (status in ('scheduled','held','cancelled','no_show')),
  summary text,
  calendar_event_id text,
  meeting_url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_meetings_lead_starts on public.meetings(lead_id, starts_at desc);
create index if not exists idx_meetings_assigned_starts on public.meetings(assigned_to_user_id, starts_at) where assigned_to_user_id is not null;
create index if not exists idx_meetings_status_starts on public.meetings(status, starts_at);

create table if not exists public.webinars (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  starts_at timestamptz not null,
  zoom_link text,
  status text not null default 'scheduled' check (status in ('scheduled','completed','cancelled')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_webinars_starts on public.webinars(starts_at desc);

create table if not exists public.webinar_registrations (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  webinar_id uuid not null references public.webinars(id) on delete cascade,
  registered_at timestamptz not null default now(),
  attended boolean,
  purchased boolean not null default false,
  source text,
  metadata jsonb not null default '{}'::jsonb,
  unique (lead_id, webinar_id)
);

create index if not exists idx_webinar_registrations_webinar on public.webinar_registrations(webinar_id, registered_at desc);
create index if not exists idx_webinar_registrations_lead on public.webinar_registrations(lead_id, registered_at desc);

create table if not exists public.program_members (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  joined_at timestamptz not null default now(),
  progress_stage text not null default 'joined',
  client_profile jsonb not null default '{}'::jsonb,
  keep_alive_state jsonb not null default '{}'::jsonb,
  portal_user_id text,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists idx_program_members_progress on public.program_members(progress_stage);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_deals_touch_updated_at on public.deals;
create trigger trg_deals_touch_updated_at before update on public.deals
for each row execute function public.touch_updated_at();

drop trigger if exists trg_meetings_touch_updated_at on public.meetings;
create trigger trg_meetings_touch_updated_at before update on public.meetings
for each row execute function public.touch_updated_at();

drop trigger if exists trg_webinars_touch_updated_at on public.webinars;
create trigger trg_webinars_touch_updated_at before update on public.webinars
for each row execute function public.touch_updated_at();

drop trigger if exists trg_program_members_touch_updated_at on public.program_members;
create trigger trg_program_members_touch_updated_at before update on public.program_members
for each row execute function public.touch_updated_at();
