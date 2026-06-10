-- 055_attention_inbox_extend_kinds.sql
--
-- Tier 0.C of the v4 redesign: surface the new "fall-between-chairs"
-- watchers (added in sla-worker for Tier 0.B) as distinct inbox kinds
-- so Mia can filter by them in the /inbox UI. Without this, every new
-- watcher just shows up as a generic 'queue' row and the morning view
-- is back to looking like an undifferentiated list.
--
-- The RPC keeps the same return shape as migration 053 (column-for-
-- column identical) — only the `kind` value coming out of the queue
-- CTE changes, dispatched off w.queue_type. DROP + CREATE because the
-- previous signature came from a DROP-CREATE chain too; CREATE OR
-- REPLACE would fail on Postgres' "cannot change return type" guard
-- if a future column gets added.

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
  created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH q AS (
    SELECT
      -- Map specific queue_type values to their own kind so the UI can
      -- chip-filter them; fall back to generic 'queue' for the rest.
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
      w.created_at
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
      l.last_inbound_at AS created_at
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
      l.next_action_due_at AS created_at
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
