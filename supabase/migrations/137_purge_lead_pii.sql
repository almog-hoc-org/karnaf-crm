-- 137_purge_lead_pii.sql
--
-- pii-delete used to call purge_removed_pii(p_retention_days => -1), a
-- function that anonymises EVERY lead with removed_by_request = true
-- whose updated_at is older than now() + 1 day — i.e. all of them. Mia
-- soft-deletes twenty leads by mistake (leads-manage 'delete' is documented
-- as restorable), an owner then erases one unrelated lead on request, and
-- the twenty come back from 'restore' as '[redacted]'.
--
-- This is the per-lead version: the same lead columns as 012, plus the
-- conversation text that purge_removed_pii never touched — a GDPR erasure
-- that leaves the customer's messages in `messages` is not an erasure.

create or replace function public.purge_lead_pii(p_lead_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_found boolean;
begin
  update public.leads set
    full_name = '[redacted]',
    email = null,
    phone = null,
    city = null,
    notes_internal = null,
    pain_point_summary = null,
    goal_summary = null,
    conversation_summary = null,
    raw_import_snapshot = '{}'::jsonb,
    -- Channel identities added after 012: with ig_user_id kept, the next
    -- Instagram DM re-attached to the "erased" lead and refreshed its handle.
    ig_user_id = null,
    ig_username = null,
    external_id = null,
    snooze_note = null,
    outcome_note = null,
    lost_reason = null,
    removed_by_request = true,
    do_not_contact = true,
    consent_email = false,
    consent_whatsapp = false
  where id = p_lead_id;
  get diagnostics v_found = row_count;
  if not v_found then
    return false;
  end if;

  update public.messages set
    content_text = '[redacted]',
    raw_payload = '{}'::jsonb,
    media_url = null,
    media_storage_path = null,
    sender_name = case when sender_type = 'lead' then '[redacted]' else sender_name end
  where lead_id = p_lead_id;

  -- The activity feed mirrors message text into title/body (054) and the
  -- ON CONFLICT path does not refresh the title, so it must be redacted here.
  update public.activities set
    title = case when actor_type = 'lead' then '[redacted]' else title end,
    body = case when body is not null then '[redacted]' else null end,
    payload = '{}'::jsonb
  where contact_id = p_lead_id and activity_type = 'message';

  -- The model's input carries the lead's name, phone and the transcript.
  update public.ai_decisions set
    input_context_json = '{}'::jsonb,
    raw_output_json = '{}'::jsonb
  where lead_id = p_lead_id;

  -- Event payloads carry identifiers (merge records, intake echoes,
  -- opt-out texts). Strip the keys that hold them; keep the audit shape.
  update public.lead_events set
    event_payload = (event_payload
      - 'phone' - 'email' - 'full_name' - 'text' - 'snippet' - 'subject' - 'sender_name'
      - 'merged_phone' - 'merged_email' - 'merged_ig_user_id' - 'merged_external_id'
      - 'igsid' - 'ig_username' - 'reply_text' - 'content' - 'raw' - 'payload')
      || jsonb_build_object('redacted', true)
  where lead_id = p_lead_id;

  update public.conversations set
    last_summary = null,
    channel_thread_id = null,
    provider_thread_ref = null
  where lead_id = p_lead_id;

  return true;
end;
$$;

revoke all on function public.purge_lead_pii(uuid) from public;
revoke all on function public.purge_lead_pii(uuid) from anon, authenticated;
grant execute on function public.purge_lead_pii(uuid) to service_role;

comment on function public.purge_lead_pii(uuid) is
  'Anonymise ONE lead on request (pii-delete). purge_removed_pii(int) stays the nightly '
  'retention sweep over leads removed more than N days ago.';
