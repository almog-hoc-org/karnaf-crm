-- 062_message_templates.sql
--
-- Tier 2.A — message template registry.
--
-- The v4 spec nominates 16 Hebrew WhatsApp templates (Appendix C, C1
-- through C16) that cover every recurring outbound conversation Karnaf
-- has: first contact, follow-up nudges, freelancer matchmaking, payment
-- confirmations, presale offers, escalation to human, etc. Until now
-- the bot generated each reply freeform and Mia typed every manual
-- response from scratch. That's exactly the "עמוסה" overload the
-- redesign is fighting.
--
-- Design choices:
--   * channel + key is the lookup pair. A future SMS or email version
--     of the same template (e.g. C3 "SMS backup") gets its own row;
--     the application code asks for (channel='sms', key='c3') and
--     gets the SMS variant without falling back to WhatsApp.
--   * body is plain Hebrew with {{var}} interpolation markers. The
--     rendered application layer expands these against a context
--     object (contact, deal, partner, etc.). The spec lists the
--     variable names per template in Appendix C.
--   * variables_used is an explicit array of the names the template
--     expects. The /templates admin UI uses this to show Mia "this
--     template needs these fields populated on the contact" so she
--     doesn't send a half-filled message. It's also what the renderer
--     uses to validate before send — if a required variable is null,
--     refuse and surface the missing field name.
--   * tags categorise (sales / nurture / ops / partner / escalation)
--     so the UI can group + filter. Free-text array so categories
--     can grow.
--   * status: draft → active → deprecated. draft templates are
--     visible in the admin UI but cannot be sent. deprecated remains
--     readable for old conversations but excluded from the picker.
--
-- RLS: staff full access. Templates aren't customer-readable.

create table if not exists public.message_templates (
  id uuid primary key default gen_random_uuid(),
  -- Stable identifier the application layer references in code. The
  -- spec calls them C1..C16 — using lowercase so it composes well in
  -- URLs / config files.
  key text not null,
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'sms', 'email')),
  name_he text not null,
  description text,
  -- The actual text. {{first_name}}, {{partner_name}}, etc.
  body text not null,
  -- Names of the variables the body uses. The renderer enforces this
  -- as a contract — sending with a missing required var is refused at
  -- the application layer with a clear "var X missing" error.
  variables_used text[] not null default '{}'::text[],
  tags text[] not null default '{}'::text[],
  status text not null default 'active' check (status in ('draft', 'active', 'deprecated')),
  -- Hand-written notes for the human editor — "use this only after
  -- the lead has confirmed availability", etc.
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One key per channel — sending the same template twice in the same
-- channel is what you want updates to do (UPSERT), not duplicates.
create unique index if not exists uniq_message_templates_key_channel
  on public.message_templates(key, channel);

create index if not exists idx_message_templates_status
  on public.message_templates(channel, status, key)
  where status = 'active';

drop trigger if exists trg_message_templates_updated_at on public.message_templates;
create trigger trg_message_templates_updated_at
  before update on public.message_templates
  for each row execute function public.set_updated_at();

alter table public.message_templates enable row level security;

drop policy if exists message_templates_staff_all on public.message_templates;
create policy message_templates_staff_all on public.message_templates
  for all to authenticated
  using (public.is_active_staff())
  with check (public.is_active_staff());

grant select, insert, update, delete on public.message_templates to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- Seed the 16 templates from spec Appendix C verbatim. Almog approved
-- each one; using the exact wording is non-negotiable — paraphrased
-- versions risk losing the tone the brand has standardised on.
--
-- ON CONFLICT DO NOTHING means subsequent runs of this migration
-- (e.g. against a partially-seeded DB) preserve any local edits Mia
-- has already made.
-- ─────────────────────────────────────────────────────────────────────
insert into public.message_templates (key, channel, name_he, description, body, variables_used, tags)
values
  ('c1', 'whatsapp',
    'פתיחה לליד חדש',
    'הודעת ברוכים הבאים אוטומטית + תפריט סינון 3 מסלולים. נשלחת בשכבה 2 של הבוט.',
    'היי {{first_name}}! 🌟 הגעת לקרנף נדל"ן 🦏 שמחים שאתה כאן. כדי שנכוון אותך נכון — מה הכי מעניין אותך? 1️⃣ ללמוד לקנות דירה (הדרך לדירה) 2️⃣ ליווי אישי להשקעת נדל"ן 3️⃣ קבוצות רכישה / פריסייל',
    array['first_name'], array['sales', 'first_contact']),
  ('c2', 'whatsapp',
    'עדות תלמיד — הדרך לדירה',
    'נרצ''ר לליד הדרך לדירה שלא רכש תוך 24 שעות. שולח וידאו עדות.',
    '{{first_name}}, רצינו לשתף אותך — תוך כמה חודשים בוגרי "הדרך לדירה" עוברים מ"לא יודע מאיפה להתחיל" לדירה ראשונה. הנה סיפור קצר: [לינק]. רוצה שנספר לך איך זה עובד?',
    array['first_name'], array['nurture', 'program']),
  ('c3', 'sms',
    'גיבוי SMS — לא נקרא וואטסאפ',
    'נשלח כש-WA לא נקראה 72 שעות. ערוץ SMS, לא WA.',
    'היי {{first_name}}, ניסינו ליצור קשר בוואטסאפ 🌟 נשמח לעזור לך עם הצעד הבא בנדל"ן. מתי נוח לדבר?',
    array['first_name'], array['nurture', 'sms']),
  ('c4', 'whatsapp',
    'החייאת ליד רדום',
    'נשלח אחרי 14 ימים ללא פעילות. ערך חינמי כדי להחזיר עניין.',
    '{{first_name}}, חשבנו עליך 😊 ריכזנו 3 טעויות שכמעט כל קונה דירה ראשונה עושה — שווה דקה: [לינק]. אם בא לך לדבר, אנחנו כאן.',
    array['first_name'], array['nurture', 'reengagement']),
  ('c5', 'whatsapp',
    'שיבוץ — הודעה לפרילנסר',
    'נשלח לפרילנסר כשהוא משויך לליד חדש בליווי משקיעים.',
    'ליד חדש לליווי 🔔 {{first_name}}, טלפון {{phone}}, תקציב {{investment_budget}}, אזור {{preferred_area}}. נא ליצור קשר תוך 24ש'' ולעדכן שלב במערכת.',
    array['first_name', 'phone', 'investment_budget', 'preferred_area'], array['partner', 'investor_mentorship']),
  ('c6', 'whatsapp',
    'שיבוץ — הודעה לליד',
    'מאשר לליד שהוא שובץ לפרילנסר ומציין מי יחזור אליו.',
    '{{first_name}}, מעולה! 🙌 שייכנו אותך ל-{{partner_name}}, מומחה הליווי שלנו. הוא יחזור אליך בקרוב לתיאום שיחת היכרות ללא עלות.',
    array['first_name', 'partner_name'], array['sales', 'investor_mentorship']),
  ('c7', 'whatsapp',
    'גישה לקורס — הדרך לדירה',
    'נשלח עם רכישת התוכנית. לינק גישה לקורס.',
    'ברוך הבא ל"הדרך לדירה"! 🎉 {{first_name}}, הנה הגישה שלך לקורס: [לינק]. מתחילים? כל שאלה — אנחנו כאן.',
    array['first_name'], array['onboarding', 'program']),
  ('c8', 'whatsapp',
    'תזכורת שיחה — לפרילנסר',
    'נשלח לפרילנסר שעה לפני שיחת המכירה.',
    'תזכורת: שיחת מכירה עם {{first_name}} בעוד שעה ({{meeting_time}}). טלפון: {{phone}}.',
    array['first_name', 'meeting_time', 'phone'], array['partner', 'investor_mentorship']),
  ('c9', 'whatsapp',
    'תזכורת שיחה — לליד',
    'נשלח לליד שעה/יום לפני שיחת היכרות עם פרילנסר.',
    '{{first_name}}, מזכירים — שיחת ההיכרות שלך עם {{partner_name}} מתוכננת ל-{{meeting_time}} 🗓️ . מצפים לדבר!',
    array['first_name', 'partner_name', 'meeting_time'], array['sales', 'reminder']),
  ('c10', 'whatsapp',
    'עדכון עמלה — פנימי לקרנף',
    'הודעה לקבוצה הפנימית של קרנף כשעמלה נוצרת. לא נשלח ללקוח.',
    '💰 דמי רצינות התקבלו! {{first_name}} | פרילנסר: {{partner_name}} | עסקה צפויה: {{deal_value}} | עמלת קרנף: {{commission_amount}} (סטטוס: ממתין).',
    array['first_name', 'partner_name', 'deal_value', 'commission_amount'], array['internal', 'commission']),
  ('c11', 'whatsapp',
    'עידוד תלמיד',
    'נשלח לתלמיד שלא נכנס לקורס יותר מ-7 ימים.',
    '{{first_name}}, שמנו לב שלא נכנסת לקורס לאחרונה 😊 גם 15 דקות מקדמות אותך לדירה. רוצה שנקבע פגישת ליווי קצרה כדי לחזור למסלול?',
    array['first_name'], array['retention', 'program']),
  ('c12', 'whatsapp',
    'בקשת המלצה',
    'נשלח לתלמיד שסיים את הקורס.',
    'כל הכבוד על סיום הקורס, {{first_name}}! 🏆 אם הוא עזר לך — נשמח להמלצה קצרה: [לינק]. תודה שאתה חלק מקרנף 🦏',
    array['first_name'], array['retention', 'social_proof']),
  ('c13', 'whatsapp',
    'אפסייל לליווי משקיעים',
    'נשלח לבוגר תוכנית כדי להציע ליווי אישי.',
    '{{first_name}}, עכשיו כשיש לך את הידע — רוצה שנלווה אותך אישית עד העסקה? "ליווי משקיעים" של קרנף לוקח אותך צעד-צעד עד החתימה. נספר לך עוד?',
    array['first_name'], array['upsell', 'investor_mentorship']),
  ('c14', 'whatsapp',
    'הצעת פריסייל',
    'נשלח לאיש קשר רלוונטי כשפרויקט פריסייל חדש נפתח.',
    '{{first_name}}, נפתחה הזדמנות 🏗️ פרויקט {{project_name}} ב{{city}} — קבוצת רכישה במחיר מתחת לשוק. מתאים לתקציב שלך. רוצה פרטים מלאים?',
    array['first_name', 'project_name', 'city'], array['sales', 'presale']),
  ('c15', 'whatsapp',
    'חוזה כוונות — פריסייל',
    'נשלח כשליד נרשם לקבוצת רכישה.',
    '{{first_name}}, מצורף חוזה הכוונות לפרויקט {{project_name}} 📋 [לינק]. לשמירת מקומך נדרשת מקדמה עד {{target_date}}. נשמח לעזור בכל שאלה.',
    array['first_name', 'project_name', 'target_date'], array['sales', 'presale']),
  ('c16', 'whatsapp',
    'מסירה לאדם — escalation',
    'נשלח כשהבוט מעביר את השיחה לטיפול אנושי.',
    '{{first_name}}, מעבירים אותך לנציג אנושי שיוכל לעזור בדיוק במה שאתה צריך 🙋. ניצור קשר בקרוב מאוד.',
    array['first_name'], array['escalation'])
on conflict (key, channel) do nothing;

comment on table public.message_templates is
  'Tier 2.A — Hebrew message template registry. C1..C16 from v4 spec '
  'Appendix C. Editable via /templates admin page; rendered by the '
  'application layer against contact/deal/partner context.';
