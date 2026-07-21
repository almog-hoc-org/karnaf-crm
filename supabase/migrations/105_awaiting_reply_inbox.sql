-- 105_awaiting_reply_inbox.sql
--
-- "Replied but unanswered" leads must be first in line. Previously only
-- mia_active leads surfaced (kind mia_reply, hardcoded priority 2 — which
-- sorted BELOW every priority-1 ops item), and an AI-owned lead whose
-- inbound went unanswered appeared only after the 7-minute ai-watchdog
-- delay as ai_stuck. Now every active lead with
-- last_inbound_at > coalesce(last_outbound_at) surfaces regardless of
-- ownership, at priority 1, with age-aware reasons. Kind stays
-- 'mia_reply' for mia_active (preserves existing labels) and is
-- 'awaiting_reply' otherwise. Leads that already carry a pending
-- human_handoff/failed_automation queue row are excluded to avoid
-- double rows for the same situation.
--
-- Same return shape as migration 092 (no column changes) — CREATE OR
-- REPLACE is enough; kept as DROP+CREATE for consistency with 092.

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
  awaiting_reply AS (
    SELECT
      CASE WHEN l.ownership_mode = 'mia_active' THEN 'mia_reply' ELSE 'awaiting_reply' END::text AS kind,
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
      CASE
        WHEN now() - l.last_inbound_at > interval '2 hours'
          THEN 'הלקוח כתב וממתין לתשובה מעל שעתיים!'
        ELSE 'הלקוח כתב — ממתין לתשובה'
      END AS reason,
      l.last_inbound_at AS due_at,
      l.last_inbound_at AS created_at,
      EXISTS (SELECT 1 FROM program_members pm WHERE pm.lead_id = l.id) AS is_program_member
    FROM leads l
    WHERE l.last_inbound_at IS NOT NULL
      AND (l.last_outbound_at IS NULL OR l.last_outbound_at < l.last_inbound_at)
      AND l.lead_status NOT IN ('won','lost','do_not_contact','removed_by_request')
      AND COALESCE(l.do_not_contact, false) = false
      AND COALESCE(l.removed_by_request, false) = false
      AND NOT EXISTS (
        SELECT 1 FROM work_queue w2
        WHERE w2.lead_id = l.id
          AND w2.status IN ('pending','claimed')
          AND w2.queue_type IN ('human_handoff','failed_automation')
      )
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
    UNION ALL SELECT * FROM awaiting_reply
    UNION ALL SELECT * FROM overdue_action
  )
  SELECT * FROM unioned
  ORDER BY priority_level ASC, due_at ASC NULLS LAST, created_at DESC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.attention_inbox(int) FROM public;
GRANT EXECUTE ON FUNCTION public.attention_inbox(int) TO authenticated, service_role;
