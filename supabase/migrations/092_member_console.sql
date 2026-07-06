-- 087_member_console.sql
--
-- Program-member service console: the CRM's shift from pure lead-capture
-- to serving paying members of "הדרך לדירה".
--
--   1. program_members gains provenance (joined_via) and the concierge
--      episode timestamps the deterministic member bot needs.
--   2. attention_inbox() returns is_program_member so the inbox can
--      badge member conversations.
--   3. Seed the three concierge texts as editable message_templates and
--      the concierge knobs (John's number, episode gap, expert SLA) in
--      crm_config — nothing hardcoded in functions.

-- 1. program_members columns ------------------------------------------------

alter table public.program_members
  add column if not exists joined_via text,
  add column if not exists concierge_last_greeted_at timestamptz,
  add column if not exists concierge_last_reprompted_at timestamptz;

comment on column public.program_members.joined_via is
  'How the member row was created: payment | won | manual | import.';
comment on column public.program_members.concierge_last_greeted_at is
  'Last time the member concierge sent the welcome (John referral) message.';
comment on column public.program_members.concierge_last_reprompted_at is
  'Last time the member concierge sent the short reminder within an episode.';

-- 2. attention_inbox + is_program_member -------------------------------------
-- Same shape as migration 055 plus one trailing boolean column. DROP+CREATE
-- because the return type changes.

DROP FUNCTION IF EXISTS public.attention_inbox(int);

CREATE FUNCTION public.attention_inbox(p_limit int DEFAULT 200)
RETURNS TABLE (
  kind text,
  ref_id uuid,
  lead_id uuid,
  lead_name text,
  lead_phone text,
  lead_status text,
  lead_heat text,
  ownership_mode text,
  product_interest text,
  suggested_next_action text,
  intake_segment text,
  queue_type text,
  queue_summary text,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  priority_level int,
  reason text,
  due_at timestamptz,
  created_at timestamptz,
  is_program_member boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH q AS (
    SELECT
      CASE w.queue_type
        WHEN 'deal_stalled' THEN 'deal_stalled'
        WHEN 'meeting_outcome_pending' THEN 'meeting_outcome_pending'
        WHEN 'phone_overdue' THEN 'phone_overdue'
        WHEN 'ai_stuck' THEN 'ai_stuck'
        WHEN 'phone_escalation' THEN 'phone_escalation'
        ELSE 'queue'
      END::text AS kind,
      w.id AS ref_id,
      w.lead_id,
      l.full_name AS lead_name,
      l.phone AS lead_phone,
      l.lead_status::text AS lead_status,
      l.lead_heat::text AS lead_heat,
      l.ownership_mode::text AS ownership_mode,
      l.product_interest::text AS product_interest,
      l.suggested_next_action::text AS suggested_next_action,
      l.intake_segment::text AS intake_segment,
      w.queue_type::text AS queue_type,
      w.queue_summary::text AS queue_summary,
      l.last_inbound_at,
      l.last_outbound_at,
      w.priority_level,
      COALESCE(w.reason, w.queue_summary, w.queue_type) AS reason,
      w.due_at,
      w.created_at,
      EXISTS (SELECT 1 FROM program_members pm WHERE pm.lead_id = l.id) AS is_program_member
    FROM work_queue w
    JOIN leads l ON l.id = w.lead_id
    WHERE w.status IN ('pending','claimed')
  ),
  mia_pending AS (
    SELECT
      'mia_reply'::text AS kind,
      l.id AS ref_id,
      l.id AS lead_id,
      l.full_name AS lead_name,
      l.phone AS lead_phone,
      l.lead_status::text AS lead_status,
      l.lead_heat::text AS lead_heat,
      l.ownership_mode::text AS ownership_mode,
      l.product_interest::text AS product_interest,
      l.suggested_next_action::text AS suggested_next_action,
      l.intake_segment::text AS intake_segment,
      null::text AS queue_type,
      null::text AS queue_summary,
      l.last_inbound_at,
      l.last_outbound_at,
      2 AS priority_level,
      'הלקוח השיב — נדרשת תגובה ידנית'::text AS reason,
      l.last_inbound_at AS due_at,
      l.last_inbound_at AS created_at,
      EXISTS (SELECT 1 FROM program_members pm WHERE pm.lead_id = l.id) AS is_program_member
    FROM leads l
    WHERE l.ownership_mode = 'mia_active'
      AND l.last_inbound_at IS NOT NULL
      AND (l.last_outbound_at IS NULL OR l.last_outbound_at < l.last_inbound_at)
      AND COALESCE(l.do_not_contact, false) = false
      AND COALESCE(l.removed_by_request, false) = false
  ),
  overdue_action AS (
    SELECT
      'overdue_action'::text AS kind,
      l.id AS ref_id,
      l.id AS lead_id,
      l.full_name AS lead_name,
      l.phone AS lead_phone,
      l.lead_status::text AS lead_status,
      l.lead_heat::text AS lead_heat,
      l.ownership_mode::text AS ownership_mode,
      l.product_interest::text AS product_interest,
      l.suggested_next_action::text AS suggested_next_action,
      l.intake_segment::text AS intake_segment,
      null::text AS queue_type,
      null::text AS queue_summary,
      l.last_inbound_at,
      l.last_outbound_at,
      1 AS priority_level,
      COALESCE('פעולה הבאה באיחור: ' || NULLIF(l.next_action_type, ''), 'פעולה הבאה באיחור') AS reason,
      l.next_action_due_at AS due_at,
      l.next_action_due_at AS created_at,
      EXISTS (SELECT 1 FROM program_members pm WHERE pm.lead_id = l.id) AS is_program_member
    FROM leads l
    WHERE l.next_action_due_at IS NOT NULL
      AND l.next_action_due_at < now()
      AND l.lead_status NOT IN ('won','lost','do_not_contact','removed_by_request')
  ),
  unioned AS (
    SELECT * FROM q
    UNION ALL SELECT * FROM mia_pending
    UNION ALL SELECT * FROM overdue_action
  )
  SELECT * FROM unioned
  ORDER BY priority_level ASC, due_at ASC NULLS LAST, created_at DESC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.attention_inbox(int) FROM public;
GRANT EXECUTE ON FUNCTION public.attention_inbox(int) TO authenticated, service_role;

-- 3. Concierge texts (editable in /templates) --------------------------------

insert into public.message_templates (key, channel, name_he, description, body, variables_used, tags, status, notes)
values
  (
    'member_welcome_v1', 'whatsapp',
    'חבר תוכנית — קבלת פנים והפניה לג''ון',
    'ההודעה הראשונה שחבר תוכנית מקבל כשהוא פונה בוואטסאפ: הפניה לג''ון לשאלות ידע, ומילת "מומחה" למענה אנושי.',
    E'היי {{first_name}}, כאן צוות קרנף נדל"ן 🦏\nלשאלות ידע ותוכן מהתוכנית — דברו עם ג''ון, הסוכן הדיגיטלי החכם שלנו, בוואטסאפ {{john_phone}} (לחברי התוכנית בלבד!).\nאם ג''ון לא סיפק מענה או שיש שאלה נוספת — כתבו כאן "מומחה" ונחזור אליכם תוך 24 שעות לכל היותר.',
    array['first_name','john_phone'],
    array['member','service'],
    'active',
    'נשלחת פעם אחת בתחילת כל פנייה חדשה של חבר תוכנית. עריכה כאן משנה את מה שהבוט שולח.'
  ),
  (
    'member_reprompt_v1', 'whatsapp',
    'חבר תוכנית — תזכורת ג''ון/מומחה',
    'תזכורת קצרה אם חבר התוכנית ממשיך לכתוב באותה פנייה בלי לבקש מומחה.',
    E'רק מזכירים 🙂 לשאלות תוכן — ג''ון בוואטסאפ {{john_phone}}. לכל דבר אחר כתבו "מומחה" ומומחה אנושי יחזור אליכם תוך 24 שעות.',
    array['john_phone'],
    array['member','service'],
    'active',
    'נשלחת לכל היותר פעם אחת בכל פנייה; אחר כך הבוט שותק והפנייה ממתינה בתיבת הנציג.'
  ),
  (
    'member_expert_ack_v1', 'whatsapp',
    'חבר תוכנית — אישור בקשת מומחה',
    'אישור אוטומטי כשחבר תוכנית כותב "מומחה" — הליד עובר לנציג אנושי עם יעד 24 שעות.',
    E'קיבלנו! מומחה מהצוות יחזור אליכם תוך 24 שעות לכל היותר 🙏',
    array[]::text[],
    array['member','service'],
    'active',
    'נשלחת מיד כשמזוהה בקשת מומחה/נציג. הליד נכנס לתור טיפול אנושי עם SLA של 24 שעות.'
  )
on conflict (key, channel) do nothing;

-- 4. Concierge config ---------------------------------------------------------

insert into public.crm_config (config_key, config_value)
values (
  'member_concierge',
  jsonb_build_object(
    'enabled', true,
    'john_phone', '055-3083507',
    'episode_gap_hours', 6,
    'expert_sla_hours', 24
  )
)
on conflict (config_key) do nothing;
