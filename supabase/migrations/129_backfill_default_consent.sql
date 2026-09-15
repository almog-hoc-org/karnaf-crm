-- 129_backfill_default_consent.sql
--
-- Owner's answer (2026-09-15, "כן"): the leads created before migration 128
-- that still had no consent decision — 18 on that day, 17 whatsapp and 1
-- manual_entry — get the same default opt-in every new lead now gets.
-- An explicit false (a removal request) is never overwritten; only NULL
-- becomes true. Idempotent: a second run touches nothing.

do $$
declare
  v_granted integer := 0;
begin
  with granted as (
    update public.leads
       set consent_email = coalesce(consent_email, true),
           consent_whatsapp = coalesce(consent_whatsapp, true),
           consent_updated_at = now()
     where consent_email is null or consent_whatsapp is null
    returning id, source
  ),
  logged as (
    insert into public.lead_events (lead_id, event_type, actor_type, event_payload)
    select id, 'consent_granted', 'system',
           jsonb_build_object('channels', jsonb_build_array('email', 'whatsapp'),
                              'basis', 'default_opt_in', 'source', source,
                              'backfill', true, 'migration', '129')
      from granted
    returning lead_id
  )
  select count(*) into v_granted from logged;

  raise notice 'default consent backfill: % leads granted', v_granted;
end $$;
