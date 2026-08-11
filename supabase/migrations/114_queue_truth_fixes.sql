-- 114_queue_truth_fixes.sql
--
-- Triage truth fixes, part 1 of the operator-UX overhaul.
--
-- 1) CRITICAL: whatsapp-webhook routeLeadToOption inserts queue types
--    presale_followup_due / investor_followup_due, but the CHECK from 096
--    never included them -> 23514 mid-routing: the lead's track was set
--    but the follow-up message never sent and the webhook 500'd. Every
--    investor/presale menu pick hit this.
-- 2) work_queue.last_signal_at: "when did this signal last fire" for the
--    new refresh mode of ensurePendingQueueItem. created_at stays the
--    historical truth (and is load-bearing for dedupe).
-- 3) One-time cleanup of the overdue_action flood: orchestrate-message
--    used to stamp next_action_due_at = now()+30min after EVERY AI reply
--    (default else-branch, removed in this release), turning nearly every
--    AI-touched lead into a permanent priority-1 "פעולה באיחור" row.
--    Manually scheduled meetings are preserved.

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
      'whatsapp_topic_unselected'::text,
      'presale_followup_due'::text,
      'investor_followup_due'::text
    ])
  );

ALTER TABLE public.work_queue
  ADD COLUMN IF NOT EXISTS last_signal_at timestamptz;

-- Irreversible by design: these values are default-stamp noise, not data.
UPDATE public.leads
SET next_action_due_at = NULL
WHERE next_action_due_at < now()
  AND (next_action_type IS DISTINCT FROM 'scheduled_meeting')
  AND lead_status NOT IN ('won','lost','do_not_contact','removed_by_request');
