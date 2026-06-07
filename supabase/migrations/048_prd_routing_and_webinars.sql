-- PRD v1 Phase 2 foundation: routing config, deal stage transitions,
-- WhatsApp topic-state, and webinar event intake support.

create table if not exists public.whatsapp_router_options (
  id uuid primary key default gen_random_uuid(),
  option_key text not null unique,
  display_order int not null default 100,
  label_he text not null,
  match_terms text[] not null default '{}'::text[],
  track text not null check (track in ('program','presale','investor_mentorship','human')),
  stage text,
  interest_topic text,
  presale_project text,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_router_options_active on public.whatsapp_router_options(is_active, display_order);
create index if not exists idx_whatsapp_router_options_terms on public.whatsapp_router_options using gin(match_terms);

insert into public.whatsapp_router_options(option_key, display_order, label_he, match_terms, track, stage, interest_topic)
values
  ('program', 10, 'תכנית הליווי / הדרך לדירה', array['1','תכנית','תוכנית','ליווי','דרך לדירה','קורס'], 'program', 'new', 'תכנית הליווי'),
  ('presale', 20, 'פריסייל / פרויקט בקדם־מכירה', array['2','פריסייל','פרויקט','חתימה','קדם מכירה'], 'presale', 'new', 'פריסייל'),
  ('investor_mentorship', 30, 'ליווי משקיעים אישי', array['3','משקיעים','משקיע','ליווי משקיעים','שחר'], 'investor_mentorship', 'form_submitted', 'ליווי משקיעים'),
  ('human', 90, 'מעבר לנציג אנושי', array['4','נציג','אנושי','בן אדם','מישהו','שיחה'], 'human', null, 'נציג אנושי')
on conflict (option_key) do update set
  display_order = excluded.display_order,
  label_he = excluded.label_he,
  match_terms = excluded.match_terms,
  track = excluded.track,
  stage = excluded.stage,
  interest_topic = excluded.interest_topic,
  updated_at = now();

create table if not exists public.whatsapp_router_state (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  status text not null default 'awaiting_topic' check (status in ('awaiting_topic','routed','human_requested','expired')),
  last_prompted_at timestamptz,
  selected_option_key text references public.whatsapp_router_options(option_key) on delete set null,
  selected_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_router_state_status on public.whatsapp_router_state(status, last_prompted_at);

create table if not exists public.deal_stage_history (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  from_stage text,
  to_stage text not null,
  actor_type text not null,
  actor_id uuid,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_deal_stage_history_deal on public.deal_stage_history(deal_id, created_at desc);
create index if not exists idx_deal_stage_history_lead on public.deal_stage_history(lead_id, created_at desc);

create or replace function public.advance_deal_stage(
  p_deal_id uuid,
  p_to_stage text,
  p_actor_type text,
  p_reason text default null,
  p_actor_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
) returns public.deals
language plpgsql security definer set search_path = public as $$
declare
  v_deal public.deals;
  v_from text;
  v_status text := 'open';
begin
  if p_to_stage is null or length(trim(p_to_stage)) = 0 then
    raise exception 'target deal stage is required';
  end if;

  select * into v_deal from public.deals where id = p_deal_id for update;
  if v_deal.id is null then
    return null;
  end if;
  v_from := v_deal.stage;

  if p_to_stage in ('paid_program_member','signed','closed_won') then
    v_status := 'won';
  elsif p_to_stage in ('not_relevant','lost') then
    v_status := 'lost';
  else
    v_status := 'open';
  end if;

  update public.deals
    set stage = p_to_stage,
        status = v_status,
        closed_at = case when v_status in ('won','lost') then now() else null end,
        updated_at = now()
    where id = p_deal_id
    returning * into v_deal;

  insert into public.deal_stage_history(deal_id, lead_id, from_stage, to_stage, actor_type, actor_id, reason, metadata)
  values (p_deal_id, v_deal.lead_id, v_from, p_to_stage, coalesce(p_actor_type, 'system'), p_actor_id, p_reason, coalesce(p_metadata, '{}'::jsonb));

  insert into public.lead_events(lead_id, event_type, actor_type, actor_id, event_payload)
  values (v_deal.lead_id, 'deal_stage_changed', coalesce(p_actor_type, 'system'), p_actor_id,
    jsonb_build_object('deal_id', p_deal_id, 'track', v_deal.track, 'from_stage', v_from, 'to_stage', p_to_stage, 'reason', p_reason) || coalesce(p_metadata, '{}'::jsonb));

  return v_deal;
end;
$$;

revoke all on function public.advance_deal_stage(uuid, text, text, text, uuid, jsonb) from public;
grant execute on function public.advance_deal_stage(uuid, text, text, text, uuid, jsonb) to authenticated, service_role;

drop trigger if exists trg_whatsapp_router_options_touch_updated_at on public.whatsapp_router_options;
create trigger trg_whatsapp_router_options_touch_updated_at before update on public.whatsapp_router_options
for each row execute function public.touch_updated_at();

drop trigger if exists trg_whatsapp_router_state_touch_updated_at on public.whatsapp_router_state;
create trigger trg_whatsapp_router_state_touch_updated_at before update on public.whatsapp_router_state
for each row execute function public.touch_updated_at();
