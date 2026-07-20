-- 098_template_sync_cron.sql
--
-- Nightly Meta template sync: pulls approval status + live body for every
-- WhatsApp template from Meta and records them on message_templates
-- (metadata.meta) via the meta-template-status function's 'sync' action.
-- Alerts on non-approved templates. Uses the shared sla_worker_secret and
-- a hardcoded URL fallback, same as the other cron callers (042 pattern).

CREATE OR REPLACE FUNCTION public.run_template_sync()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  v_url text := current_setting('app.template_sync_url', true);
  v_secret text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'sla_worker_secret'
    ORDER BY created_at DESC
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_secret := NULL;
  END;

  IF v_url IS NULL OR v_url = '' THEN
    v_url := 'https://svkzkpgccahwmyflobvn.supabase.co/functions/v1/meta-template-status';
  END IF;

  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE NOTICE 'sla_worker_secret not set in vault; skipping template sync';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('action', 'sync', 'trigger', 'cron')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.run_template_sync() FROM public;
GRANT EXECUTE ON FUNCTION public.run_template_sync() TO service_role;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'karnaf_template_sync') THEN
    PERFORM cron.schedule('karnaf_template_sync', '10 3 * * *',
      $cmd$ SELECT public.run_template_sync(); $cmd$);
  END IF;
END $$;
