-- 101_dispatch_zombie_reclaim.sql
--
-- A dispatch row claimed by a worker that died mid-send stayed
-- 'in_flight' forever — the claim RPC only selects 'pending', so the
-- item was never retried and a broadcast recipient hanging off it sat
-- 'enqueued' indefinitely, holding the whole broadcast in 'sending'.
--
-- Track claim time and requeue stale in_flight rows (15 min, well past
-- the worker's own timeouts) at the top of every claim.

ALTER TABLE public.outbound_dispatch
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

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
  -- Zombie reclaim: a worker that died after claiming never completes or
  -- fails its rows. Push them back to pending so the next tick retries.
  UPDATE public.outbound_dispatch od
     SET status = 'pending',
         next_attempt_at = now(),
         last_error = coalesce(od.last_error, 'reclaimed: worker died mid-flight')
   WHERE od.status = 'in_flight'
     AND (od.claimed_at IS NULL OR od.claimed_at < now() - interval '15 minutes');

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
         attempts = od.attempts + 1,
         claimed_at = now()
   WHERE od.id IN (SELECT claimed.id FROM claimed)
  RETURNING od.id, od.lead_id, od.conversation_id, od.payload, od.attempts, od.correlation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_outbound_dispatch(integer) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_outbound_dispatch(integer) TO service_role;
