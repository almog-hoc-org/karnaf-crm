-- Creates a brand-new lead exactly the way the intakes do (upsert_lead_smart
-- as service_role, then the follow-up writes), inside a transaction that is
-- rolled back. Any trigger that breaks lead creation fails this file — the
-- way migration 128's consent trigger silently failed every new lead in
-- production for two weeks (fixed in 134).
\set ON_ERROR_STOP 1
begin;
set local role service_role;

select public.check_rate_limit('db-smoke', 3600, 10) as rate_limit_ok;

create temp table smoke_lead on commit drop as
  select * from public.upsert_lead_smart(
    '+972500009901', 'smoke@example.com', 'db smoke', 'landing_page', 'form', '{"smoke": true}'::jsonb);

do $$
declare
  v public.leads;
  v_events integer;
begin
  select * into v from smoke_lead;
  if v.id is null then raise exception 'upsert_lead_smart returned no lead'; end if;
  if v.created_at <> v.updated_at then raise exception 'new lead not detectable as new (created_at <> updated_at)'; end if;
  if v.consent_email is distinct from true or v.consent_whatsapp is distinct from true then
    raise exception 'default consent not granted on insert';
  end if;

  select count(*) into v_events from public.lead_events
   where lead_id = v.id and event_type = 'consent_granted';
  if v_events <> 1 then raise exception 'expected 1 consent_granted event, found %', v_events; end if;

  -- website-leads-intake follow-up writes
  update public.leads
     set source_detail = 'website', source_campaign = 'karnaf_website',
         consent_email = false, consent_whatsapp = false, consent_updated_at = now()
   where id = v.id;
  insert into public.lead_events(lead_id, event_type, actor_type, event_payload)
  values (v.id, 'intake_received', 'system', '{}'::jsonb),
         (v.id, 'consent_not_given', 'system', '{"basis": "website_checkbox_unticked"}'::jsonb);
  insert into public.work_queue(lead_id, queue_type, priority_level, status, reason, queue_summary,
                                created_by_actor_type, due_at, payload_json)
  values (v.id, 'first_response_due', 2, 'pending', 'db smoke', 'db smoke', 'system',
          now() + interval '4 hours', '{}'::jsonb);

  -- the same person again: matched, not duplicated
  perform public.upsert_lead_smart('+972500009901', null, null, 'landing_page', 'form', '{}'::jsonb);
  if (select count(*) from public.leads where phone = '+972500009901') <> 1 then
    raise exception 'repeat submission created a duplicate lead';
  end if;
end $$;

select 'lead path ok' as result;
rollback;
