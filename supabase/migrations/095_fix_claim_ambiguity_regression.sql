-- 095_fix_claim_ambiguity_regression.sql
--
-- Migration 090 rewrote claim_outbound_dispatch() to add priority ordering
-- and, in doing so, reintroduced the exact PL/pgSQL ambiguity migration 043
-- had fixed: `WHERE od.id IN (SELECT id FROM claimed)` — `id` collides with
-- the RETURNS TABLE output variable, so every call since the 090 deploy
-- failed with `column reference "id" is ambiguous` and the dispatcher could
-- not claim anything. The queue has been silently accumulating.
--
-- Two steps, in order:
--   1. Dead-letter stale pending items that piled up while the claim was
--      broken (older than 12h, excluding broadcast sends) — releasing a
--      week of stale bot replies at once would message leads days late.
--   2. Recreate the RPC with priority ordering AND the 043 qualification.

UPDATE public.outbound_dispatch
   SET status = 'dlq',
       failed_at = now(),
       last_error = 'expired by migration 095: queued while claim RPC was broken (090 regression)'
 WHERE status = 'pending'
   AND created_at < now() - interval '12 hours'
   AND payload->>'broadcast_id' IS NULL;

CREATE OR REPLACE FUNCTION public.claim_outbound_dispatch(p_batch_size integer DEFAULT 10)
RETURNS TABLE(
  id uuid,
  lead_id uuid,
  conversation_id uuid,
  payload jsonb,
  attempts integer,
  correlation_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT od.id
    FROM public.outbound_dispatch od
    WHERE od.status = 'pending'
      AND od.next_attempt_at <= now()
    ORDER BY od.priority ASC, od.next_attempt_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.outbound_dispatch od
     SET status = 'in_flight',
         attempts = od.attempts + 1
   WHERE od.id IN (SELECT claimed.id FROM claimed)
  RETURNING od.id, od.lead_id, od.conversation_id, od.payload, od.attempts, od.correlation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_outbound_dispatch(integer) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_outbound_dispatch(integer) TO service_role;
