-- 119_attention_inbox_v5.sql
--
-- attention_inbox v5 — the row carries enough to REPLY, not just to read.
--
-- The inbox's reply lane tells the operator "the customer is waiting" but
-- offers no way to answer: the only composer lives in the lead page, so
-- answering five waiting customers costs five navigations there and back
-- (or a wa.me detour that leaves no trace in the CRM). The web app now
-- embeds an inline composer on reply cards; send-reply requires a real
-- conversation id (it is the messages-insert FK), so the row must carry
-- one.
--
-- Changes vs 118 (v4) — two columns appended, nothing else touched:
-- 1. last_inbound_conversation_id — the conversation of the customer's
--    latest inbound message. Resolved inside the SAME LATERAL join that
--    already fetches last_inbound_text, so it costs nothing extra.
-- 2. last_inbound_channel — that conversation's channel ('whatsapp' /
--    'instagram'), so the composer can show the right out-of-window copy
--    (WhatsApp templates vs IG "queued until the customer writes").
--
-- Return shape: v4 columns unchanged and in the same order; new columns
-- appended at the end. daily-sales-inbox and dashboard-summary read by
-- name and keep working untouched. A client running against the old RPC
-- simply sees the fields as undefined and hides the inline composer.

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
  is_program_member boolean,
  source text,
  source_detail text,
  source_campaign text,
  utm_campaign text,
  landing_page text,
  last_inbound_text text,
  last_inbound_conversation_id uuid,
  last_inbound_channel text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH base AS (
    SELECT l.*,
           EXISTS (SELECT 1 FROM program_members pm WHERE pm.lead_id = l.id) AS is_member
    FROM leads l
    WHERE l.lead_status NOT IN ('won','lost','do_not_contact','removed_by_request','duplicate')
      AND COALESCE(l.do_not_contact, false) = false
      AND COALESCE(l.removed_by_request, false) = false
      AND l.outcome IS NULL
      AND (l.snoozed_until IS NULL OR l.snoozed_until <= now())
  ),
  reply AS (
    SELECT
      CASE WHEN b.ownership_mode = 'mia_active' THEN 'mia_reply' ELSE 'awaiting_reply' END::text AS kind,
      b.id AS ref_id,
      b.id AS lead_id,
      b.full_name AS lead_name,
      b.phone AS lead_phone,
      b.lead_status::text,
      b.lead_heat::text,
      b.ownership_mode::text,
      b.product_interest::text,
      b.suggested_next_action::text,
      b.intake_segment::text,
      NULL::text AS queue_type,
      NULL::text AS queue_summary,
      b.last_inbound_at,
      b.last_outbound_at,
      1 AS priority_level,
      CASE WHEN now() - b.last_inbound_at > interval '2 hours'
           THEN 'הלקוח כתב וממתין לתשובה מעל שעתיים!'
           ELSE 'הלקוח כתב — ממתין לתשובה' END AS reason,
      b.last_inbound_at AS due_at,
      b.last_inbound_at AS created_at,
      b.is_member AS is_program_member
    FROM base b
    WHERE b.last_inbound_at IS NOT NULL
      AND (b.last_outbound_at IS NULL OR b.last_outbound_at < b.last_inbound_at)
      AND (b.triage_cleared_at IS NULL OR b.triage_cleared_at < b.last_inbound_at)
  ),
  snooze_pop AS (
    SELECT
      'snooze_due'::text AS kind,
      b.id, b.id,
      b.full_name, b.phone,
      b.lead_status::text, b.lead_heat::text, b.ownership_mode::text,
      b.product_interest::text, b.suggested_next_action::text, b.intake_segment::text,
      NULL::text, NULL::text,
      b.last_inbound_at, b.last_outbound_at,
      1 AS priority_level,
      COALESCE('חזר מהשהיה: ' || NULLIF(b.snooze_note, ''), 'חזר מהשהיה — הגיע מועד הבדיקה החוזרת') AS reason,
      b.snoozed_until AS due_at,
      b.snoozed_until AS created_at,
      b.is_member
    FROM base b
    WHERE b.snoozed_until IS NOT NULL AND b.snoozed_until <= now()
      AND (b.triage_cleared_at IS NULL OR b.triage_cleared_at < b.snoozed_until)
  ),
  overdue AS (
    SELECT
      'overdue_action'::text AS kind,
      b.id, b.id,
      b.full_name, b.phone,
      b.lead_status::text, b.lead_heat::text, b.ownership_mode::text,
      b.product_interest::text, b.suggested_next_action::text, b.intake_segment::text,
      NULL::text, NULL::text,
      b.last_inbound_at, b.last_outbound_at,
      2 AS priority_level,
      COALESCE('פעולה הבאה באיחור: ' || NULLIF(b.next_action_type, ''), 'פעולה הבאה באיחור') AS reason,
      b.next_action_due_at AS due_at,
      b.next_action_due_at AS created_at,
      b.is_member
    FROM base b
    WHERE b.next_action_due_at IS NOT NULL AND b.next_action_due_at < now()
      AND b.last_inbound_at IS NOT NULL
      AND COALESCE(b.no_proactive_contact, false) = false
      AND (b.triage_cleared_at IS NULL OR b.triage_cleared_at < b.next_action_due_at)
  ),
  q AS (
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
      b.full_name, b.phone,
      b.lead_status::text, b.lead_heat::text, b.ownership_mode::text,
      b.product_interest::text, b.suggested_next_action::text, b.intake_segment::text,
      w.queue_type::text,
      w.queue_summary::text,
      b.last_inbound_at, b.last_outbound_at,
      GREATEST(w.priority_level, 2) AS priority_level,
      COALESCE(w.reason, w.queue_summary, w.queue_type) AS reason,
      w.due_at,
      COALESCE(w.last_signal_at, w.created_at) AS created_at,
      b.is_member
    FROM work_queue w
    JOIN base b ON b.id = w.lead_id
    WHERE w.status IN ('pending','claimed')
      AND b.last_inbound_at IS NOT NULL
      AND (b.triage_cleared_at IS NULL
           OR b.triage_cleared_at < COALESCE(w.last_signal_at, w.created_at))
      AND NOT (COALESCE(b.no_proactive_contact, false)
           AND w.queue_type IN ('nurture_due','dormant_review','weekend_carryover','low_fit_cleanup'))
  ),
  unioned AS (
    SELECT * FROM reply
    UNION ALL SELECT * FROM snooze_pop
    UNION ALL SELECT * FROM overdue
    UNION ALL SELECT * FROM q
  ),
  ranked AS (
    SELECT u.*,
           ROW_NUMBER() OVER (
             PARTITION BY u.lead_id
             ORDER BY
               CASE u.kind
                 WHEN 'mia_reply' THEN 0
                 WHEN 'awaiting_reply' THEN 0
                 WHEN 'snooze_due' THEN 1
                 WHEN 'phone_escalation' THEN 2
                 WHEN 'phone_overdue' THEN 2
                 WHEN 'ai_stuck' THEN 3
                 WHEN 'deal_stalled' THEN 3
                 WHEN 'overdue_action' THEN 3
                 WHEN 'meeting_outcome_pending' THEN 4
                 ELSE 5
               END ASC,
               u.priority_level ASC,
               u.due_at ASC NULLS LAST
           ) AS rn
    FROM unioned u
  ),
  final AS (
    SELECT kind, ref_id, lead_id, lead_name, lead_phone, lead_status, lead_heat,
           ownership_mode, product_interest, suggested_next_action, intake_segment,
           queue_type, queue_summary, last_inbound_at, last_outbound_at,
           priority_level, reason, due_at, created_at, is_program_member
    FROM ranked
    WHERE rn = 1
    ORDER BY priority_level ASC, due_at ASC NULLS LAST, created_at DESC
    LIMIT p_limit
  )
  SELECT f.kind, f.ref_id, f.lead_id, f.lead_name, f.lead_phone, f.lead_status,
         f.lead_heat, f.ownership_mode, f.product_interest, f.suggested_next_action,
         f.intake_segment, f.queue_type, f.queue_summary, f.last_inbound_at,
         f.last_outbound_at, f.priority_level, f.reason, f.due_at, f.created_at,
         f.is_program_member,
         l.source, l.source_detail, l.source_campaign, l.utm_campaign, l.landing_page,
         m.last_inbound_text,
         m.last_inbound_conversation_id,
         m.last_inbound_channel
  FROM final f
  JOIN leads l ON l.id = f.lead_id
  LEFT JOIN LATERAL (
    SELECT left(msg.content_text, 240) AS last_inbound_text,
           msg.conversation_id AS last_inbound_conversation_id,
           c.channel::text AS last_inbound_channel
    FROM messages msg
    LEFT JOIN conversations c ON c.id = msg.conversation_id
    WHERE msg.lead_id = f.lead_id
      AND msg.direction = 'inbound'
      AND NULLIF(trim(msg.content_text), '') IS NOT NULL
    ORDER BY msg.created_at DESC
    LIMIT 1
  ) m ON true
  ORDER BY f.priority_level ASC, f.due_at ASC NULLS LAST, f.created_at DESC;
$$;

REVOKE ALL ON FUNCTION public.attention_inbox(int) FROM public;
GRANT EXECUTE ON FUNCTION public.attention_inbox(int) TO authenticated, service_role;
