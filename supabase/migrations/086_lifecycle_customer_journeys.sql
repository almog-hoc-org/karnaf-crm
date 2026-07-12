-- 086_lifecycle_customer_journeys.sql
--
-- Recovered 2026-07-09 from production's
-- supabase_migrations.schema_migrations (the file was applied to
-- prod but never committed). Statements are verbatim as recorded
-- by the Supabase CLI at apply time.

-- 086_lifecycle_customer_journeys.sql
--
-- Customer lifecycle layer for "Haderech Ladira":
-- 1) welcome for landing/form leads,
-- 2) welcome for paid students,
-- 3) recurring biweekly student check-ins.

create table if not exists public.student_lifecycle_state (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  last_checkin_at timestamptz,
  checkin_count int not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_student_lifecycle_state_updated_at on public.student_lifecycle_state;

create trigger trg_student_lifecycle_state_updated_at
  before update on public.student_lifecycle_state
  for each row execute function public.set_updated_at();

alter table public.student_lifecycle_state enable row level security;

drop policy if exists student_lifecycle_state_staff_read on public.student_lifecycle_state;

create policy student_lifecycle_state_staff_read on public.student_lifecycle_state
  for select to authenticated using (public.is_active_staff());

grant select, insert, update, delete on public.student_lifecycle_state to service_role;

insert into public.message_templates
  (key, channel, name_he, description, body, variables_used, tags, status, notes, metadata)
values
  (
    'karnaf_landing_welcome_v1',
    'whatsapp',
    'פתיחת שיחה לליד מטופס נחיתה',
    'נשלחת לליד שהשאיר פרטים באתר/טופס והתעניין בדרך לדירה.',
    'היי {{first_name}}, ראינו שהתעניינת בתוכנית ״הדרך לדירה״ של קרנף נדל״ן. נשמח לעזור לך להבין מה הצעד הבא בדרך לרכישת דירה בצורה עצמאית ואחראית.' || E'\n\n' || 'אפשר לענות כאן ונכוון אותך.',
    array['first_name'],
    array['lifecycle', 'landing_page', 'welcome', 'whatsapp'],
    'active',
    'Meta template name: karnaf_landing_welcome_v1, language he.',
    jsonb_build_object(
      'meta_template_name', 'karnaf_landing_welcome_v1',
      'meta_language', 'he',
      'meta_category', 'MARKETING',
      'expected_params', jsonb_build_array('first_name'),
      'meta_status', 'PENDING'
    )
  ),
  (
    'karnaf_student_welcome_v1',
    'whatsapp',
    'ברוכים הבאים לתלמיד חדש',
    'נשלחת לאחר רכישת הדרך לדירה / הצטרפות לתלמידים.',
    'ברוך הבא ל״הדרך לדירה״, {{first_name}}! שמחים שאתה איתנו. אם יש שאלה, התלבטות או משהו שלא ברור במהלך הדרך, אפשר לכתוב כאן ונעזור.' || E'\n\n' || 'בהצלחה מהצוות של קרנף.',
    array['first_name'],
    array['lifecycle', 'student', 'welcome', 'whatsapp'],
    'active',
    'Meta template name: karnaf_student_welcome_v1, language he.',
    jsonb_build_object(
      'meta_template_name', 'karnaf_student_welcome_v1',
      'meta_language', 'he',
      'meta_category', 'MARKETING',
      'expected_params', jsonb_build_array('first_name'),
      'meta_status', 'PENDING'
    )
  ),
  (
    'karnaf_student_checkin_14d_v1',
    'whatsapp',
    'צ׳ק-אין דו שבועי לתלמיד',
    'נשלחת לתלמידים פעילים כל 14 יום כדי לבדוק התקדמות ושאלות.',
    'היי {{first_name}}, בודקים איתך איך מתקדם בדרך לדירה. יש משהו שתקוע, שאלה על השיעורים או החלטה שצריך לחשוב עליה יחד?' || E'\n\n' || 'אפשר לענות כאן ונעזור.',
    array['first_name'],
    array['lifecycle', 'student', 'checkin', 'whatsapp'],
    'active',
    'Meta template name: karnaf_student_checkin_14d_v1, language he.',
    jsonb_build_object(
      'meta_template_name', 'karnaf_student_checkin_14d_v1',
      'meta_language', 'he',
      'meta_category', 'MARKETING',
      'expected_params', jsonb_build_array('first_name'),
      'meta_status', 'PENDING'
    )
  )
on conflict (key, channel) do update set
  name_he = excluded.name_he,
  description = excluded.description,
  body = excluded.body,
  variables_used = excluded.variables_used,
  tags = excluded.tags,
  status = excluded.status,
  notes = excluded.notes,
  metadata = excluded.metadata,
  updated_at = now();

insert into public.automation_rules
  (code, name_he, description, trigger_event, category, source, enabled, implementation_ref, actions)
values
  (
    'lifecycle_landing_lead_welcome',
    'פתיחת מסע לליד מטופס נחיתה',
    'שולח הודעת פתיחה מאושרת ללידים שמגיעים מטופס/אתר ומתעניינים בדרך לדירה.',
    'lead.created',
    'lifecycle',
    'engine',
    true,
    'leads-intake + automation-engine',
    jsonb_build_array(
      jsonb_build_object('type', 'send_template', 'key', 'karnaf_landing_welcome_v1', 'channel', 'whatsapp', 'once', true)
    )
  ),
  (
    'lifecycle_student_welcome_and_checkins',
    'ברוכים הבאים לתלמיד חדש',
    'שולח הודעת ברוכים הבאים לאחר רכישה; הצ׳ק-אין הדו שבועי מנוהל על ידי automation-tick.',
    'payment.completed',
    'lifecycle',
    'engine',
    true,
    'payment-webhook + automation-engine + automation-tick',
    jsonb_build_array(
      jsonb_build_object('type', 'send_template', 'key', 'karnaf_student_welcome_v1', 'channel', 'whatsapp', 'once', true)
    )
  ),
  (
    'lifecycle_student_biweekly_checkin',
    'צ׳ק-אין דו שבועי לתלמידים',
    'סורק תלמידים משלמים ושולח הודעת בדיקה כל 14 יום עם state למניעת כפילויות.',
    'student.biweekly_checkin',
    'lifecycle',
    'engine',
    true,
    'automation-tick + student-lifecycle',
    jsonb_build_array(
      jsonb_build_object('type', 'send_template', 'key', 'karnaf_student_checkin_14d_v1', 'channel', 'whatsapp')
    )
  )
on conflict (code) do update set
  name_he = excluded.name_he,
  description = excluded.description,
  trigger_event = excluded.trigger_event,
  category = excluded.category,
  source = excluded.source,
  enabled = excluded.enabled,
  implementation_ref = excluded.implementation_ref,
  actions = excluded.actions,
  updated_at = now();
