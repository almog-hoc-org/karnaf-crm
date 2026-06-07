-- PRD v1 Phase 2b: explicit intake payload contracts per source/form.

create table if not exists public.intake_source_contracts (
  id uuid primary key default gen_random_uuid(),
  contract_key text not null unique,
  source_slug text not null references public.lead_sources(slug) on update cascade on delete cascade,
  display_name text not null,
  description text,
  required_fields text[] not null default '{}'::text[],
  field_aliases jsonb not null default '{}'::jsonb,
  default_track text check (default_track is null or default_track in ('program','presale','investor_mentorship')),
  default_stage text,
  default_interest_topic text,
  default_tags text[] not null default '{}'::text[],
  example_payload jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_intake_source_contracts_source on public.intake_source_contracts(source_slug, is_active, contract_key);
create index if not exists idx_intake_source_contracts_active on public.intake_source_contracts(is_active, contract_key);

insert into public.lead_sources (slug, display_name, sort_order) values
  ('webinar_registration', 'הרשמה לוובינר', 21),
  ('phone_call_request', 'בקשת שיחה', 22),
  ('presale_form', 'טופס פריסייל / חתימה', 23),
  ('investor_mentorship_form', 'טופס ליווי משקיעים', 24),
  ('whatsapp_topic_selection', 'בחירת נושא בוואטסאפ', 51)
on conflict (slug) do update set
  display_name = excluded.display_name,
  sort_order = excluded.sort_order,
  is_active = true,
  updated_at = now();

insert into public.intake_source_contracts(
  contract_key,
  source_slug,
  display_name,
  description,
  required_fields,
  field_aliases,
  default_track,
  default_stage,
  default_interest_topic,
  default_tags,
  example_payload
) values
  (
    'webinar_registration_v1',
    'webinar_registration',
    'הרשמה לוובינר — תכנית הליווי',
    'Landing/webinar provider payload for a program webinar registration.',
    array['webinar_name','webinar_date'],
    '{
      "full_name": ["name", "lead_name", "שם מלא"],
      "phone": ["mobile", "טלפון"],
      "email": ["mail", "אימייל"],
      "webinar_name": ["webinar_title", "event_name"],
      "webinar_date": ["starts_at", "event_date"],
      "campaign_name": ["utm_campaign", "campaign"]
    }'::jsonb,
    'program',
    'webinar_registered',
    'וובינר תכנית הליווי',
    array['program','webinar'],
    '{"contract_key":"webinar_registration_v1","source":"webinar_registration","full_name":"ישראל ישראלי","phone":"0501234567","email":"lead@example.com","webinar_name":"וובינר הדרך לדירה","webinar_date":"2026-06-10T18:00:00+03:00","consent_whatsapp":true}'::jsonb
  ),
  (
    'phone_call_request_v1',
    'phone_call_request',
    'בקשת שיחה כללית',
    'Generic callback request from website/landing pages.',
    array[]::text[],
    '{
      "full_name": ["name", "lead_name", "שם מלא"],
      "phone": ["mobile", "טלפון"],
      "email": ["mail", "אימייל"],
      "preferred_time": ["callback_time", "time_preference"],
      "message": ["notes", "free_text", "question"]
    }'::jsonb,
    'program',
    'phone_call_booked',
    'בקשת שיחה',
    array['callback'],
    '{"contract_key":"phone_call_request_v1","source":"phone_call_request","full_name":"ישראל ישראלי","phone":"0501234567","preferred_time":"מחר בבוקר","message":"רוצה להבין התאמה לתכנית"}'::jsonb
  ),
  (
    'presale_form_v1',
    'presale_form',
    'פריסייל / חתימה',
    'Presale landing form for project interest and signing flow.',
    array['presale_project'],
    '{
      "full_name": ["name", "lead_name", "שם מלא"],
      "phone": ["mobile", "טלפון"],
      "email": ["mail", "אימייל"],
      "presale_project": ["project", "project_name", "שם פרויקט"],
      "partner_name": ["partner", "broker", "שותף"],
      "message": ["notes", "free_text", "question"]
    }'::jsonb,
    'presale',
    'new',
    'פריסייל',
    array['presale'],
    '{"contract_key":"presale_form_v1","source":"presale_form","full_name":"ישראל ישראלי","phone":"0501234567","presale_project":"פרויקט לדוגמה","partner_name":"שותף א"}'::jsonb
  ),
  (
    'investor_mentorship_form_v1',
    'investor_mentorship_form',
    'ליווי משקיעים',
    'Investor mentorship request routed to Shahar/investor follow-up.',
    array[]::text[],
    '{
      "full_name": ["name", "lead_name", "שם מלא"],
      "phone": ["mobile", "טלפון"],
      "email": ["mail", "אימייל"],
      "city": ["location", "עיר"],
      "message": ["notes", "free_text", "question"],
      "budget": ["investment_budget", "תקציב"]
    }'::jsonb,
    'investor_mentorship',
    'form_submitted',
    'ליווי משקיעים',
    array['investor_mentorship'],
    '{"contract_key":"investor_mentorship_form_v1","source":"investor_mentorship_form","full_name":"ישראל ישראלי","phone":"0501234567","budget":"1.2M","message":"מחפש ליווי להשקעה"}'::jsonb
  ),
  (
    'whatsapp_topic_selection_v1',
    'whatsapp_topic_selection',
    'בחירת נושא בוואטסאפ',
    'Internal/automation contract documenting WhatsApp topic selections.',
    array['interest_topic'],
    '{"interest_topic":["topic","selected_topic"],"message":["text","body"]}'::jsonb,
    null,
    null,
    null,
    array['whatsapp_router'],
    '{"contract_key":"whatsapp_topic_selection_v1","source":"whatsapp_topic_selection","phone":"0501234567","interest_topic":"פריסייל"}'::jsonb
  )
on conflict (contract_key) do update set
  source_slug = excluded.source_slug,
  display_name = excluded.display_name,
  description = excluded.description,
  required_fields = excluded.required_fields,
  field_aliases = excluded.field_aliases,
  default_track = excluded.default_track,
  default_stage = excluded.default_stage,
  default_interest_topic = excluded.default_interest_topic,
  default_tags = excluded.default_tags,
  example_payload = excluded.example_payload,
  is_active = true,
  updated_at = now();

drop trigger if exists trg_intake_source_contracts_touch_updated_at on public.intake_source_contracts;
create trigger trg_intake_source_contracts_touch_updated_at before update on public.intake_source_contracts
for each row execute function public.touch_updated_at();
