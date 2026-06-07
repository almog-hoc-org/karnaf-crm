-- Fix dispatch queue claim RPC ambiguity found in production.
-- In PL/pgSQL, the RETURNS TABLE column `id` can collide with unqualified
-- SELECT id inside the function body. Qualify claimed.id explicitly so the
-- dispatcher can drain pending WhatsApp/AI replies.

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
    ORDER BY od.next_attempt_at ASC
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
