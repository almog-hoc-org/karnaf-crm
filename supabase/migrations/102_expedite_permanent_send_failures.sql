-- 102_expedite_permanent_send_failures.sql
--
-- One-time data fix: dispatch items failing on PERMANENT Meta errors
-- (#131009 invalid parameter / bad phone, #132018 bad template param)
-- sat in exponential backoff for hours, holding their broadcast in
-- 'sending'. Pull their next attempt to now — the retry either succeeds
-- (sanitized params) or hits max attempts / the new permanent-error
-- fast path and dead-letters immediately, letting the broadcast close.

UPDATE public.outbound_dispatch
   SET next_attempt_at = now()
 WHERE status = 'pending'
   AND (last_error LIKE '%131009%' OR last_error LIKE '%132018%');
