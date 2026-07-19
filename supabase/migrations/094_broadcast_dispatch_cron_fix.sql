-- 094_broadcast_dispatch_cron_fix.sql
--
-- Broadcasts scheduled in the UI never left 'scheduled': the minutely
-- run_broadcast_dispatch() cron (migration 090) silently skipped unless
-- app.broadcast_dispatch_url and a vault broadcast_dispatch_secret were
-- both configured by hand — steps that were never performed in the hosted
-- project. Migration 042 fixed the identical flaw in run_outbound_dispatch
-- with a hardcoded URL fallback; this applies the same fix here, plus a
-- secret fallback to the already-provisioned outbound_dispatch_secret so
-- the pipeline works with zero new manual configuration. The edge function
-- accepts the same fallback (BROADCAST_DISPATCH_SECRET, else
-- OUTBOUND_DISPATCH_SECRET).

CREATE OR REPLACE FUNCTION public.run_broadcast_dispatch()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  v_url text := current_setting('app.broadcast_dispatch_url', true);
  v_secret text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'broadcast_dispatch_secret'
    ORDER BY created_at DESC
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_secret := NULL;
  END;

  IF v_secret IS NULL OR v_secret = '' THEN
    BEGIN
      SELECT decrypted_secret INTO v_secret
      FROM vault.decrypted_secrets
      WHERE name = 'outbound_dispatch_secret'
      ORDER BY created_at DESC
      LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      v_secret := NULL;
    END;
  END IF;

  IF v_url IS NULL OR v_url = '' THEN
    v_url := 'https://svkzkpgccahwmyflobvn.supabase.co/functions/v1/broadcast-dispatch';
  END IF;

  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE NOTICE 'broadcast_dispatch secret not set (vault: broadcast_dispatch_secret / outbound_dispatch_secret); skipping';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('trigger', 'cron')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.run_broadcast_dispatch() FROM public;
GRANT EXECUTE ON FUNCTION public.run_broadcast_dispatch() TO service_role;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'karnaf_broadcast_dispatch') THEN
    PERFORM cron.schedule('karnaf_broadcast_dispatch', '* * * * *',
      $cmd$ SELECT public.run_broadcast_dispatch(); $cmd$);
  END IF;
END $$;
