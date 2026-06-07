-- Persistent audit trail for admin edits to WhatsApp router options.

create table if not exists public.whatsapp_router_option_events (
  id uuid primary key default gen_random_uuid(),
  option_key text,
  action text not null check (action in ('create', 'update', 'delete')),
  actor_user_id uuid references auth.users(id) on delete set null,
  before_value jsonb,
  after_value jsonb,
  changed_fields text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_router_option_events_created_at
  on public.whatsapp_router_option_events(created_at desc);

create index if not exists idx_whatsapp_router_option_events_option_key
  on public.whatsapp_router_option_events(option_key, created_at desc);

alter table public.whatsapp_router_option_events enable row level security;

drop policy if exists "staff can read whatsapp router option events" on public.whatsapp_router_option_events;
drop policy if exists "admins can read whatsapp router option events" on public.whatsapp_router_option_events;
create policy "admins can read whatsapp router option events"
  on public.whatsapp_router_option_events
  for select
  to authenticated
  using (public.has_role(array['owner','admin']::public.user_role[]));

-- Writes happen through service-role Edge Functions only.
