-- 063_automation_catalog.sql
--
-- Tier 2.B + 2.C — automation catalog + run log.
--
-- The v4 spec § ז lists 19 automations (B1..B19) that the system
-- should be running, with editable triggers/conditions/actions. The
-- legitimate goal is "no-code admin can edit these without a deploy"
-- (Tier 4). But to get there safely we need two pieces in place first:
--
-- (B) A catalog row per automation, even the ones that live in code
--     today. The catalog answers "what automations exist + are they
--     enabled?" — visible to admin without reading the source.
--
-- (C) A run log so every fire (or skip) leaves an audit trail. Mia
--     can ask "did B5 fire for this lead?" and get an answer instead
--     of grepping logs.
--
-- This migration is the data shape + seed; the engine that uses the
-- catalog to actually drive behaviour lands in Tier 2 next phases.
-- For now, the catalog is *descriptive* (mirrors what code already
-- does) and the run log is populated opportunistically by the
-- existing automations as we wire each one in.

create table if not exists public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  -- Stable string ID. The spec uses B1..B19; lowercase here so it
  -- composes with URLs / config keys.
  code text not null unique,
  name_he text not null,
  description text,
  -- What event fires the rule. Free text now; a future migration will
  -- constrain to an enum once the engine stabilises.
  trigger_event text not null,
  -- Hand-written category for the admin UI ("nurture", "sales",
  -- "ops", "commission", "presale", "control").
  category text not null,
  -- enabled controls whether the rule actually runs. Useful for
  -- temporarily silencing a rule without deleting it.
  enabled boolean not null default true,
  -- Implementation source. 'code' means the rule lives in an edge
  -- function (the engine that lands later will respect it but won't
  -- re-fire). 'engine' means the configurable rules-engine drives it.
  -- 'planned' marks rules from the spec we haven't built yet.
  source text not null default 'code' check (source in ('code', 'engine', 'planned')),
  -- A free-text reference to where the implementation lives, for
  -- debugging. e.g. 'supabase/functions/sla-worker:phone_overdue'.
  implementation_ref text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_automation_rules_enabled
  on public.automation_rules(category, enabled) where enabled = true;

drop trigger if exists trg_automation_rules_updated_at on public.automation_rules;
create trigger trg_automation_rules_updated_at
  before update on public.automation_rules
  for each row execute function public.set_updated_at();

alter table public.automation_rules enable row level security;

drop policy if exists automation_rules_staff_all on public.automation_rules;
create policy automation_rules_staff_all on public.automation_rules
  for all to authenticated
  using (public.is_active_staff())
  with check (public.is_active_staff());

grant select, insert, update, delete on public.automation_rules to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- Run log. One row per fire (or considered-but-skipped). Mia + admin
-- read this when investigating "why didn't X fire for lead Y".
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid references public.automation_rules(id) on delete set null,
  -- Stable rule code preserved as a column so the audit row stays
  -- legible even if the rule row is later deleted.
  rule_code text not null,
  -- What triggered this run, e.g. 'sla_tick', 'message.received',
  -- 'deal.seriousness_paid'.
  trigger_event text not null,
  -- Foreign-keyed to the contact when relevant; null for system-wide
  -- runs (e.g. daily digest).
  contact_id uuid references public.leads(id) on delete cascade,
  -- Snapshot of context the rule saw. Useful for debugging "the value
  -- was wrong when the rule fired" without time-travel.
  context jsonb not null default '{}'::jsonb,
  -- What the rule did, in plain text + structured payload. result of
  -- a send_template action might be {"message_id": "...", "template_key": "c1"}.
  action_results jsonb not null default '[]'::jsonb,
  status text not null default 'success' check (status in (
    'success', 'skipped', 'failed', 'partial'
  )),
  -- Free-form when status='skipped' ("ownership=mia_active") or
  -- 'failed' ("template c1 missing var first_name").
  reason text,
  duration_ms int,
  correlation_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_automation_runs_rule_recent
  on public.automation_runs(rule_id, created_at desc);
create index if not exists idx_automation_runs_contact_recent
  on public.automation_runs(contact_id, created_at desc)
  where contact_id is not null;
create index if not exists idx_automation_runs_failed
  on public.automation_runs(status, created_at desc)
  where status = 'failed';

alter table public.automation_runs enable row level security;

drop policy if exists automation_runs_staff_read on public.automation_runs;
create policy automation_runs_staff_read on public.automation_runs
  for select to authenticated using (public.is_active_staff());

grant select, insert, delete on public.automation_runs to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- Seed the 19 automations from spec § ז. Marks which are already
-- running in code today versus which the engine will build later.
-- ON CONFLICT updates the description / source if it changes —
-- safe to re-run.
-- ─────────────────────────────────────────────────────────────────────
insert into public.automation_rules (code, name_he, description, trigger_event, category, source, implementation_ref)
values
  -- Category 1: intake + routing
  ('b1_new_lead_intake',           'קליטת ליד חדש',                       'מקצה עובד CRM ושולח הודעת פתיחה (C1)',           'lead.created',           'intake',     'code',    'leads-intake'),
  ('b2_track_set',                 'עדכון מסלול מהבוט',                   'מפעיל מסע לקוח מתאים כשמסלול עודכן',              'lead.track_set',         'intake',     'engine',  null),
  ('b3_partner_assignment',        'שיבוץ פרילנסר ללווי משקיעים',         'בוחר פרילנסר עם הכי פחות עסקאות פתוחות',          'deal.investor_open',     'partner',    'planned', 'partner_workload view ready'),
  ('b4_duplicate_detection',       'זיהוי כפילות',                         'מציע מיזוג כשטלפון קיים ברשומה אחרת',             'lead.created',           'intake',     'code',    'upsert_lead_smart RPC'),
  -- Category 2: nurture
  ('b5_program_no_purchase_24h',   'ליד הדרך לדירה לא רכש תוך 24ש',       'שולח וידאו עדות (C2)',                            'time.elapsed',           'nurture',    'planned', null),
  ('b6_hot_lead_no_reply_48h',     'ליד חם בלי מענה 48ש',                 'משימה דחופה לעובד CRM',                          'time.elapsed',           'nurture',    'planned', null),
  ('b7_sms_backup_72h',            'גיבוי SMS אחרי 72ש בלי קריאה',         'שולח את C3 בערוץ SMS',                            'time.elapsed',           'nurture',    'planned', null),
  ('b8_dormant_resurrect_14d',     'החייאת ליד רדום 14 יום',               'שולח ערך חינמי (C4)',                             'time.elapsed',           'nurture',    'code',    'sla-worker dormant query'),
  -- Category 3: sales + onboarding
  ('b9_program_purchase',          'רכישת תוכנית הדרך לדירה',              'שולח גישה לקורס (C7) ומפעיל onboarding',          'deal.won',               'sales',      'planned', null),
  ('b10_sales_call_scheduled',     'תיאום שיחת מכירה לליווי',             'תזכורות לפרילנסר ולליד (C8/C9)',                  'meeting.scheduled',      'sales',      'planned', null),
  ('b11_seriousness_deposit_paid', 'דמי רצינות שולמו',                    'יוצר עמלה ממתינה + מודיע לקרנף (C10)',           'deal.deposit_paid',      'commission', 'code',    'trg_deal_deposit_paid'),
  -- Category 4: commission + finance
  ('b12_contract_signed',          'תאריך חתימת עסקה הגיע',                'עמלה → לחיוב',                                   'deal.contract_signed',   'commission', 'code',    'trg_deal_contract_signed'),
  ('b13_accounting_webhook',       'webhook חשבונאות בסגירה',              'מודיע למערכת סליקה כשעסקה נסגרת',                'deal.closed',            'commission', 'planned', null),
  -- Category 5: retention + service
  ('b14_student_inactive_7d',      'תלמיד לא מתקדם 7 ימים',                'שולח עידוד (C11) + מציע פגישת ליווי',             'time.elapsed',           'retention',  'planned', null),
  ('b15_course_completed_upsell',  'סיום קורס → אפסייל',                  'בקשת המלצה (C12) + הצעת ליווי משקיעים (C13)',     'course.completed',       'retention',  'planned', null),
  ('b16_low_satisfaction',         'שביעות רצון נמוכה ≤ 2',                'משימה דחופה למנהל + עוצר אוטומציות שיווק',        'feedback.received',      'retention',  'planned', null),
  -- Category 6: presale
  ('b17_presale_project_opens',    'פתיחת פרויקט פריסייל',                 'שולח הצעה (C14) לאנשי קשר מתאימים',                'project.recruiting',     'presale',    'planned', null),
  ('b18_presale_signup',           'רישום לקבוצת רכישה',                   'שולח חוזה כוונות (C15) + תזכורת מקדמה',           'deal.presale_signup',    'presale',    'planned', null),
  -- Category 7: control + reporting
  ('b19_daily_recap',              'תיבת בוקר 08:00',                      'שולח דיגסט יומי למיה ב-Telegram',                  'cron.daily',             'control',    'code',    'daily-sales-inbox')
on conflict (code) do update set
  name_he = excluded.name_he,
  description = excluded.description,
  category = excluded.category,
  source = excluded.source,
  implementation_ref = excluded.implementation_ref;

comment on table public.automation_rules is
  'Tier 2.B — catalog of automations the system runs. source=code '
  'means the rule lives in an edge function; engine means the '
  'configurable engine drives it; planned marks spec rules not yet '
  'built. Admin UI reads this to show "what is running?".';

comment on table public.automation_runs is
  'Tier 2.C — audit log of every automation fire (or skip). Mia '
  'reads this when investigating why a rule did or did not fire '
  'for a particular lead. service_role inserts; staff RLS reads.';
