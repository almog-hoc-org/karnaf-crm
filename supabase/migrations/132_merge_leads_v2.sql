-- 132_merge_leads_v2.sql
--
-- merge_leads (083) had four gaps, found in the 2026-09-28 audit:
--   1. It failed outright when the survivor had no email and the duplicate
--      did: the email was copied onto the survivor while the duplicate still
--      held it, violating the unique lower(email) index. The duplicate is
--      now neutralized first.
--   2. ig_user_id never moved. The next Instagram DM (upsert_lead_by_igsid
--      matches on it) landed on the parked duplicate — status 'duplicate',
--      do_not_contact — instead of the live lead. 084 relies on exactly
--      this merge for IG leads.
--   3. Opt-outs were not carried over. A duplicate that had unsubscribed
--      (consent false, DNC, removed, no-proactive) merged into a survivor
--      that could then be marketed to. Now the strict value wins.
--   4. broadcast_recipients and student_lifecycle_state (tables newer than
--      083) were not repointed, and notes / UTM attribution were dropped.
-- Same signature, same grants; admin-actions keeps calling it unchanged.

create or replace function public.merge_leads(p_survivor uuid, p_duplicate uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dup public.leads%rowtype;
begin
  if p_survivor = p_duplicate then
    raise exception 'survivor and duplicate are the same lead';
  end if;
  select * into v_dup from public.leads where id = p_duplicate for update;
  if not found then raise exception 'duplicate lead % not found', p_duplicate; end if;
  perform 1 from public.leads where id = p_survivor for update;
  if not found then raise exception 'survivor lead % not found', p_survivor; end if;

  -- Plain repoints (no unique-per-lead constraints).
  update public.conversations set lead_id = p_survivor where lead_id = p_duplicate;
  update public.messages set lead_id = p_survivor where lead_id = p_duplicate;
  update public.lead_events set lead_id = p_survivor where lead_id = p_duplicate;
  update public.lead_tasks set lead_id = p_survivor where lead_id = p_duplicate;
  update public.ai_decisions set lead_id = p_survivor where lead_id = p_duplicate;
  update public.payment_events set lead_id = p_survivor where lead_id = p_duplicate;
  update public.work_queue set lead_id = p_survivor where lead_id = p_duplicate;
  update public.outbound_dispatch set lead_id = p_survivor where lead_id = p_duplicate;
  update public.deals set lead_id = p_survivor where lead_id = p_duplicate;
  update public.meetings set lead_id = p_survivor where lead_id = p_duplicate;
  update public.webinar_registrations set lead_id = p_survivor where lead_id = p_duplicate;
  update public.activities set contact_id = p_survivor where contact_id = p_duplicate;
  update public.automation_runs set contact_id = p_survivor where contact_id = p_duplicate;

  -- journey_runs: partial unique (definition_id, contact_id) where
  -- status='active'. Cancel the duplicate's active runs when the
  -- survivor already has one for the same definition, then repoint.
  update public.journey_runs jr
     set status = 'cancelled',
         last_error = 'cancelled by lead merge — survivor already active'
   where jr.contact_id = p_duplicate
     and jr.status = 'active'
     and exists (
       select 1 from public.journey_runs s
       where s.contact_id = p_survivor and s.definition_id = jr.definition_id and s.status = 'active'
     );
  update public.journey_runs set contact_id = p_survivor where contact_id = p_duplicate;

  -- engine_template_sends: unique (lead_id, template_key, channel) —
  -- drop the duplicate's rows that would collide, repoint the rest.
  delete from public.engine_template_sends d
   where d.lead_id = p_duplicate
     and exists (
       select 1 from public.engine_template_sends s
       where s.lead_id = p_survivor and s.template_key = d.template_key and s.channel = d.channel
     );
  update public.engine_template_sends set lead_id = p_survivor where lead_id = p_duplicate;

  -- lead_id-as-PK tables: keep the survivor's row when both exist.
  delete from public.program_members d
   where d.lead_id = p_duplicate
     and exists (select 1 from public.program_members s where s.lead_id = p_survivor);
  update public.program_members set lead_id = p_survivor where lead_id = p_duplicate;
  delete from public.whatsapp_router_state d
   where d.lead_id = p_duplicate
     and exists (select 1 from public.whatsapp_router_state s where s.lead_id = p_survivor);
  update public.whatsapp_router_state set lead_id = p_survivor where lead_id = p_duplicate;
  delete from public.student_lifecycle_state d
   where d.lead_id = p_duplicate
     and exists (select 1 from public.student_lifecycle_state s where s.lead_id = p_survivor);
  update public.student_lifecycle_state set lead_id = p_survivor where lead_id = p_duplicate;

  -- broadcast_recipients: unique (broadcast_id, lead_id). The survivor
  -- keeps its own row for a broadcast both were in; otherwise the history
  -- moves over (campaign reports stay whole).
  delete from public.broadcast_recipients d
   where d.lead_id = p_duplicate
     and exists (
       select 1 from public.broadcast_recipients s
       where s.lead_id = p_survivor and s.broadcast_id = d.broadcast_id
     );
  update public.broadcast_recipients set lead_id = p_survivor where lead_id = p_duplicate;

  -- Neutralize the duplicate FIRST: phone, email and ig_user_id carry
  -- unique indexes, so copying them onto the survivor while the duplicate
  -- still holds them violated the index — merging a survivor with no email
  -- into a duplicate that had one simply failed. Park the row out of every
  -- operational scan; original identifiers are kept in the merge event.
  update public.leads
     set phone = null,
         email = null,
         ig_user_id = null,
         lead_status = 'duplicate',
         do_not_contact = true,
         updated_at = now()
   where id = p_duplicate;

  -- Fill survivor gaps from the duplicate, union tags. Suppression is
  -- carried over the strict way: an opt-out or DNC on either record wins,
  -- so a merge can never re-subscribe someone who asked to be removed.
  -- ig_user_id moves too — otherwise the next Instagram DM (matched by
  -- ig_user_id) lands on the parked duplicate.
  update public.leads s
     set full_name = coalesce(s.full_name, v_dup.full_name),
         email = coalesce(s.email, v_dup.email),
         ig_user_id = coalesce(s.ig_user_id, v_dup.ig_user_id),
         ig_username = coalesce(s.ig_username, v_dup.ig_username),
         city = coalesce(s.city, v_dup.city),
         source_detail = coalesce(s.source_detail, v_dup.source_detail),
         source_campaign = coalesce(s.source_campaign, v_dup.source_campaign),
         product_interest = coalesce(s.product_interest, v_dup.product_interest),
         utm_source = coalesce(s.utm_source, v_dup.utm_source),
         utm_medium = coalesce(s.utm_medium, v_dup.utm_medium),
         utm_campaign = coalesce(s.utm_campaign, v_dup.utm_campaign),
         utm_content = coalesce(s.utm_content, v_dup.utm_content),
         utm_term = coalesce(s.utm_term, v_dup.utm_term),
         first_touch_at = least(s.first_touch_at, v_dup.first_touch_at),
         notes_internal = nullif(concat_ws(E'\n\n', s.notes_internal, v_dup.notes_internal), ''),
         tags = (
           select coalesce(array_agg(distinct t), '{}'::text[])
           from unnest(coalesce(s.tags, '{}'::text[]) || coalesce(v_dup.tags, '{}'::text[])) as t
         ),
         -- A row that is itself a parked duplicate got do_not_contact from
         -- that earlier merge, not from the customer — don't inherit it.
         do_not_contact = s.do_not_contact
           or (coalesce(v_dup.do_not_contact, false) and v_dup.lead_status is distinct from 'duplicate'),
         removed_by_request = s.removed_by_request or coalesce(v_dup.removed_by_request, false),
         no_proactive_contact = s.no_proactive_contact or coalesce(v_dup.no_proactive_contact, false),
         consent_email = case
           when s.consent_email is false or v_dup.consent_email is false then false
           else coalesce(s.consent_email, v_dup.consent_email) end,
         consent_whatsapp = case
           when s.consent_whatsapp is false or v_dup.consent_whatsapp is false then false
           else coalesce(s.consent_whatsapp, v_dup.consent_whatsapp) end,
         consent_updated_at = greatest(s.consent_updated_at, v_dup.consent_updated_at),
         updated_at = now()
   where s.id = p_survivor;

  insert into public.lead_events (lead_id, event_type, actor_type, event_payload)
  values
    (p_survivor, 'lead_merged', 'admin',
     jsonb_build_object('merged_from', p_duplicate, 'merged_phone', v_dup.phone, 'merged_email', v_dup.email,
                        'merged_ig_user_id', v_dup.ig_user_id)),
    (p_duplicate, 'lead_merged', 'admin',
     jsonb_build_object('merged_into', p_survivor));
end;
$$;
revoke all on function public.merge_leads(uuid, uuid) from public;
revoke all on function public.merge_leads(uuid, uuid) from anon, authenticated;
grant execute on function public.merge_leads(uuid, uuid) to service_role;
