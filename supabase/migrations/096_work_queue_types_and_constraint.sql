-- 096_work_queue_types_and_constraint.sql
--
-- The work_queue queue_type check constraint was last extended in 044
-- (ai_stuck), but code shipped since then inserts nine additional types:
-- sla-worker's deal/meeting/phone/handoff checks, the webinar journey
-- kinds, and the WhatsApp router kinds. Every such insert violates the
-- constraint (23514) in production — sla-worker has been erroring on
-- deal_stalled, and the others fail silently inside their workers.
-- Recreate the constraint as the union of everything the code writes.

ALTER TABLE public.work_queue
  DROP CONSTRAINT IF EXISTS work_queue_queue_type_check;

ALTER TABLE public.work_queue
  ADD CONSTRAINT work_queue_queue_type_check CHECK (
    queue_type = ANY (ARRAY[
      'first_response_due'::text,
      'hot_lead'::text,
      'sla_risk'::text,
      'human_handoff'::text,
      'payment_pending'::text,
      'phone_escalation'::text,
      'nurture_due'::text,
      'dormant_review'::text,
      'failed_automation'::text,
      'weekend_carryover'::text,
      'low_fit_cleanup'::text,
      'manual_review_required'::text,
      'onboarding_action'::text,
      'ai_stuck'::text,
      'deal_stalled'::text,
      'meeting_outcome_pending'::text,
      'phone_overdue'::text,
      'handoff_stale'::text,
      'webinar_registered'::text,
      'webinar_no_show'::text,
      'webinar_attended_not_purchased'::text,
      'whatsapp_human_requested'::text,
      'whatsapp_topic_unselected'::text
    ])
  );
