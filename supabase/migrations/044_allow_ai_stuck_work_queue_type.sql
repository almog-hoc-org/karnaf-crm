-- Allow SLA worker to surface AI-owned conversations that did not get an
-- outbound reply quickly enough. The code path existed, but production's
-- work_queue constraint rejected queue_type = 'ai_stuck', causing the worker
-- to fail instead of alerting operators.

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
      'ai_stuck'::text
    ])
  );
