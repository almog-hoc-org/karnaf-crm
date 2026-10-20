-- 140_merge_leads_v3.sql
--
-- merge_leads v2 (132) still had three ways to leave the survivor broken,
-- found in the 2026-10-17 audit:
--   1. Conversations were re-pointed blindly. Both leads usually have a
--      'whatsapp' conversation (that is how the duplicate got found), so the
--      survivor ended up with two, and ensureConversation's maybeSingle()
--      then threw on EVERY later inbound message and every send for that
--      customer. The duplicate's conversation is now folded into the
--      survivor's (messages, events, tasks, decisions, activities, parked
--      replies and router state move over) and deleted.
--   2. webinar_registrations has unique (lead_id, webinar_id) and deals has
--      one-open-per-track; when both leads registered for the same webinar
--      (Rav Messer double-fires) or both had an open deal on a track, the
--      update raised 23505 and the whole merge rolled back with "duplicate
--      key value" in the UI.
--   3. The duplicate's phone was nulled and never copied to the survivor.
--      084's whole point was merging an Instagram lead (no phone) with the
--      WhatsApp lead that has one.
-- Also re-points deal_stage_history, pending_manual_replies and
-- integration_logs, which 132 left on the parked duplicate; closes the
-- duplicate's pending work_queue items that the survivor already has
-- (unique pending per lead+type); keeps queued outbound turns attached
-- to the folded conversation.
-- Same signature and grants; admin-actions keeps calling it unchanged.

create or replace function public.merge_leads(p_survivor uuid, p_duplicate uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dup public.leads%rowtype;
  c record;
begin
  if p_survivor = p_duplicate then
    raise exception 'survivor and duplicate are the same lead';
  end if;
  select * into v_dup from public.leads where id = p_duplicate for update;
  if not found then raise exception 'duplicate lead % not found', p_duplicate; end if;
  perform 1 from public.leads where id = p_survivor for update;
  if not found then raise exception 'survivor lead % not found', p_survivor; end if;

  -- ── Conversations: one per (lead, channel) ─────────────────────────
  -- Where the survivor already has a conversation on the same channel, the
  -- duplicate's conversation is folded into it. Children follow; the
  -- activity mirror (054) upserts on (source_table, source_id), so moving a
  -- message does not duplicate its activity row.
  for c in
    select distinct on (d.id) d.id as dup_conv, s.id as surv_conv
    from public.conversations d
    join public.conversations s
      on s.lead_id = p_survivor and s.channel = d.channel
    where d.lead_id = p_duplicate
    order by d.id, s.last_activity_at desc nulls last, s.started_at asc
  loop
    update public.messages set conversation_id = c.surv_conv where conversation_id = c.dup_conv;
    update public.lead_events set conversation_id = c.surv_conv where conversation_id = c.dup_conv;
    update public.lead_tasks set conversation_id = c.surv_conv where conversation_id = c.dup_conv;
    update public.ai_decisions set conversation_id = c.surv_conv where conversation_id = c.dup_conv;
    update public.activities set conversation_id = c.surv_conv where conversation_id = c.dup_conv;
    update public.pending_manual_replies set conversation_id = c.surv_conv where conversation_id = c.dup_conv;
    update public.whatsapp_router_state set conversation_id = c.surv_conv where conversation_id = c.dup_conv;
    -- outbound_dispatch.conversation_id is ON DELETE SET NULL (036): a turn
    -- still queued for the duplicate's conversation would otherwise lose
    -- its conversation, 400 on every retry and dead-letter unanswered.
    update public.outbound_dispatch set conversation_id = c.surv_conv where conversation_id = c.dup_conv;
    update public.conversations s
       set last_activity_at = greatest(s.last_activity_at, d.last_activity_at),
           last_inbound_at = greatest(s.last_inbound_at, d.last_inbound_at),
           last_outbound_at = greatest(s.last_outbound_at, d.last_outbound_at),
           is_open = s.is_open or d.is_open,
           last_summary = coalesce(s.last_summary, d.last_summary),
           channel_thread_id = coalesce(s.channel_thread_id, d.channel_thread_id),
           provider_thread_ref = coalesce(s.provider_thread_ref, d.provider_thread_ref)
      from public.conversations d
     where s.id = c.surv_conv and d.id = c.dup_conv;
    delete from public.conversations where id = c.dup_conv;
  end loop;
  -- Channels the survivor did not have yet move over whole.
  update public.conversations set lead_id = p_survivor where lead_id = p_duplicate;

  -- Plain repoints (no unique-per-lead constraints).
  update public.messages set lead_id = p_survivor where lead_id = p_duplicate;
  update public.lead_events set lead_id = p_survivor where lead_id = p_duplicate;
  update public.lead_tasks set lead_id = p_survivor where lead_id = p_duplicate;
  update public.ai_decisions set lead_id = p_survivor where lead_id = p_duplicate;
  update public.payment_events set lead_id = p_survivor where lead_id = p_duplicate;
  -- work_queue: unique (lead_id, queue_type) where status = 'pending' (028).
  -- Both leads usually hold a pending first_response_due (that is what two
  -- Instagram leads for one sender look like), so a blind repoint raised
  -- 23505 and rolled the whole merge back. The duplicate's pending item is
  -- closed when the survivor already has the same kind pending.
  update public.work_queue d
     set status = 'resolved',
         resolved_at = now(),
         resolution_note = concat_ws(' | ', d.resolution_note, 'merged into survivor — same item already pending there')
   where d.lead_id = p_duplicate
     and d.status = 'pending'
     and exists (
       select 1 from public.work_queue s
       where s.lead_id = p_survivor and s.queue_type = d.queue_type and s.status = 'pending'
     );
  update public.work_queue set lead_id = p_survivor where lead_id = p_duplicate;
  update public.outbound_dispatch set lead_id = p_survivor where lead_id = p_duplicate;
  update public.meetings set lead_id = p_survivor where lead_id = p_duplicate;
  update public.activities set contact_id = p_survivor where contact_id = p_duplicate;
  update public.automation_runs set contact_id = p_survivor where contact_id = p_duplicate;
  update public.deal_stage_history set lead_id = p_survivor where lead_id = p_duplicate;
  update public.pending_manual_replies set lead_id = p_survivor where lead_id = p_duplicate;
  update public.integration_logs set lead_id = p_survivor where lead_id = p_duplicate;

  -- deals: one OPEN deal per (lead, track). A duplicate's open deal on a
  -- track where the survivor already has one is cancelled (its history is
  -- kept under the survivor via deal_stage_history), the rest move over.
  update public.deals d
     set status = 'cancelled',
         closed_at = now(),
         metadata = d.metadata || jsonb_build_object('cancelled_by_merge', p_survivor)
   where d.lead_id = p_duplicate
     and d.status = 'open'
     and exists (
       select 1 from public.deals s
       where s.lead_id = p_survivor and s.track = d.track and s.status = 'open'
     );
  update public.deals set lead_id = p_survivor where lead_id = p_duplicate;

  -- webinar_registrations: unique (lead_id, webinar_id). Keep the survivor's
  -- row, but let a duplicate that actually attended/purchased mark it.
  update public.webinar_registrations s
     set attended = coalesce(s.attended, false) or coalesce(d.attended, false),
         purchased = s.purchased or d.purchased
    from public.webinar_registrations d
   where s.lead_id = p_survivor and d.lead_id = p_duplicate and s.webinar_id = d.webinar_id;
  delete from public.webinar_registrations d
   where d.lead_id = p_duplicate
     and exists (
       select 1 from public.webinar_registrations s
       where s.lead_id = p_survivor and s.webinar_id = d.webinar_id
     );
  update public.webinar_registrations set lead_id = p_survivor where lead_id = p_duplicate;

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
  -- still holds them violated the index. Park the row out of every
  -- operational scan; original identifiers are kept in the merge event.
  update public.leads
     set phone = null,
         email = null,
         ig_user_id = null,
         external_id = null,
         lead_status = 'duplicate',
         do_not_contact = true,
         updated_at = now()
   where id = p_duplicate;

  -- Fill survivor gaps from the duplicate, union tags. Suppression is
  -- carried over the strict way: an opt-out or DNC on either record wins,
  -- so a merge can never re-subscribe someone who asked to be removed.
  update public.leads s
     set full_name = coalesce(s.full_name, v_dup.full_name),
         phone = coalesce(s.phone, v_dup.phone),
         email = coalesce(s.email, v_dup.email),
         ig_user_id = coalesce(s.ig_user_id, v_dup.ig_user_id),
         ig_username = coalesce(s.ig_username, v_dup.ig_username),
         external_source = coalesce(s.external_source, v_dup.external_source),
         external_id = coalesce(s.external_id, v_dup.external_id),
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
         last_inbound_at = greatest(s.last_inbound_at, v_dup.last_inbound_at),
         last_outbound_at = greatest(s.last_outbound_at, v_dup.last_outbound_at),
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
                        'merged_ig_user_id', v_dup.ig_user_id, 'merged_external_id', v_dup.external_id)),
    (p_duplicate, 'lead_merged', 'admin',
     jsonb_build_object('merged_into', p_survivor));
end;
$$;
revoke all on function public.merge_leads(uuid, uuid) from public;
revoke all on function public.merge_leads(uuid, uuid) from anon, authenticated;
grant execute on function public.merge_leads(uuid, uuid) to service_role;
