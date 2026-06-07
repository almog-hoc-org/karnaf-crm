-- Operator hotfixes, 2026-06-07:
-- 1) outbound_dispatch cron must not silently skip when app.outbound_dispatch_url
--    was never set in the hosted database. Keep the setting override, but fall
--    back to this project's edge-function URL.
-- 2) reopen_lead must support the UI's "פתח שיחה מחדש" path for DNC/removed
--    leads, not only won/lost leads.

CREATE OR REPLACE FUNCTION public.run_outbound_dispatch()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  v_url text := current_setting('app.outbound_dispatch_url', true);
  v_secret text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'outbound_dispatch_secret'
    ORDER BY created_at DESC
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_secret := NULL;
  END;

  IF v_url IS NULL OR v_url = '' THEN
    v_url := 'https://svkzkpgccahwmyflobvn.supabase.co/functions/v1/dispatch-outbound';
  END IF;

  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE NOTICE 'outbound_dispatch_secret not set; skipping';
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

REVOKE ALL ON FUNCTION public.run_outbound_dispatch() FROM public;
GRANT EXECUTE ON FUNCTION public.run_outbound_dispatch() TO service_role;

CREATE OR REPLACE FUNCTION public.reopen_lead(
  p_lead_id uuid,
  p_target_status text,
  p_actor_role text,
  p_reason text DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL
) RETURNS leads
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_current text;
  v_do_not_contact boolean;
  v_removed_by_request boolean;
  v_legal_targets text[] := ARRAY['responded','qualified','nurture','human_handoff'];
  v_lead leads;
  v_event_payload jsonb;
BEGIN
  IF p_actor_role IS NULL OR p_actor_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'reopen_lead requires owner or admin role (got: %)', coalesce(p_actor_role,'null');
  END IF;

  IF p_target_status IS NULL OR NOT (p_target_status = ANY (v_legal_targets)) THEN
    RAISE EXCEPTION 'reopen_lead target % is not one of %', p_target_status, v_legal_targets;
  END IF;

  SELECT lead_status, coalesce(do_not_contact, false), coalesce(removed_by_request, false)
    INTO v_current, v_do_not_contact, v_removed_by_request
    FROM leads
    WHERE id = p_lead_id
    FOR UPDATE;

  IF v_current IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_current NOT IN ('won','lost','do_not_contact')
     AND NOT v_do_not_contact
     AND NOT v_removed_by_request THEN
    RAISE EXCEPTION 'reopen_lead requires a closed/DNC lead (current: %, dnc: %, removed: %)',
      v_current, v_do_not_contact, v_removed_by_request;
  END IF;

  UPDATE leads
     SET lead_status = p_target_status,
         won_at = CASE WHEN v_current = 'won' THEN NULL ELSE won_at END,
         lost_at = CASE WHEN v_current = 'lost' THEN NULL ELSE lost_at END,
         lost_reason = CASE WHEN v_current = 'lost' THEN NULL ELSE lost_reason END,
         do_not_contact = false,
         removed_by_request = false,
         ownership_mode = 'ai_active',
         human_owner_id = NULL,
         updated_at = now()
   WHERE id = p_lead_id
   RETURNING * INTO v_lead;

  v_event_payload := jsonb_build_object(
    'from', v_current,
    'to', p_target_status,
    'reason', p_reason,
    'actor_user_id', p_actor_user_id,
    'was_do_not_contact', v_do_not_contact,
    'was_removed_by_request', v_removed_by_request
  );

  INSERT INTO lead_events(lead_id, event_type, actor_type, actor_id, event_payload)
  VALUES (p_lead_id, 'lead_reopened', p_actor_role, p_actor_user_id, v_event_payload);

  INSERT INTO lead_events(lead_id, event_type, actor_type, actor_id, event_payload)
  VALUES (p_lead_id, 'lead_status_changed', p_actor_role, p_actor_user_id, v_event_payload);

  RETURN v_lead;
END;
$$;

REVOKE ALL ON FUNCTION public.reopen_lead(uuid, text, text, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.reopen_lead(uuid, text, text, text, uuid) TO service_role;
