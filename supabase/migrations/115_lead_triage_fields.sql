-- 115_lead_triage_fields.sql
--
-- Operator triage primitives (phase B of the operator-UX overhaul):
-- "טופל" (triage_cleared_at), snooze ("לבדוק שוב בעוד X"), "אין צורך
-- בפנייה יזומה", and the outcome tag ("נסגר ל: ...").
--
-- Design (approved): outcome is NOT a lead_status — leads that closed
-- into a process leave the attention queue via exclusion but keep their
-- status machinery intact (program/investor closes still end in a real
-- 'won' through the deals flow).

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS triage_cleared_at timestamptz,
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS snoozed_at timestamptz,
  ADD COLUMN IF NOT EXISTS snooze_note text,
  ADD COLUMN IF NOT EXISTS no_proactive_contact boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS outcome text,
  ADD COLUMN IF NOT EXISTS outcome_note text,
  ADD COLUMN IF NOT EXISTS outcome_at timestamptz;

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_outcome_check;
ALTER TABLE public.leads
  ADD CONSTRAINT leads_outcome_check CHECK (
    outcome IS NULL OR outcome IN ('program', 'investor_mentorship', 'consultation', 'other')
  );

CREATE INDEX IF NOT EXISTS idx_leads_snoozed_until ON public.leads(snoozed_until)
  WHERE snoozed_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_outcome ON public.leads(outcome)
  WHERE outcome IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- Inbound message breaks snooze + un-clears triage, at the single DB
-- chokepoint every channel already passes through (the 004 trigger).
-- Body copied verbatim from 004 with the two new inbound-only resets.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.sync_lead_message_timestamps() returns trigger
language plpgsql as $$
declare
  ts timestamptz := coalesce(new.created_at, now());
begin
  update leads set
    last_message_at = ts,
    last_inbound_at = case when new.direction = 'inbound' then ts else last_inbound_at end,
    last_outbound_at = case when new.direction = 'outbound' then ts else last_outbound_at end,
    last_ai_touch_at = case when new.sender_type = 'ai' then ts else last_ai_touch_at end,
    last_human_touch_at = case when new.sender_type in ('mia','sales_rep','admin') then ts else last_human_touch_at end,
    -- a customer message is a fresh signal: it cancels an active snooze
    -- and re-opens a lead the operator had marked as handled.
    snoozed_until = case when new.direction = 'inbound' then null else snoozed_until end,
    snoozed_at = case when new.direction = 'inbound' then null else snoozed_at end,
    snooze_note = case when new.direction = 'inbound' then null else snooze_note end,
    triage_cleared_at = case when new.direction = 'inbound' then null else triage_cleared_at end
  where id = new.lead_id;
  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- State machine: nurture is now reachable from qualified and from
-- human_handoff ("אין צורך בפנייה נוספת בשלב הזה" ends up here for leads
-- mid-funnel). Full RPC body from 008 with exactly those two additions.
-- Deno/vitest mirrors updated in the same release.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.transition_lead_status(
  p_lead_id uuid,
  p_target text,
  p_actor_type text default 'system',
  p_reason text default null
) returns leads
language plpgsql security definer set search_path = public as $$
declare
  v_current text;
  v_legal text[] := array[]::text[];
  v_lead leads;
begin
  select lead_status into v_current from leads where id = p_lead_id for update;
  if v_current is null then
    return null;
  end if;

  v_legal := case v_current
    when 'new' then array['first_contact_sent','manual_review_required','do_not_contact','removed_by_request']
    when 'first_contact_sent' then array['responded','nurture','human_handoff','lost','do_not_contact','removed_by_request']
    when 'responded' then array['qualified','nurture','checkout_pushed','human_handoff','lost','do_not_contact','removed_by_request']
    when 'qualified' then array['checkout_pushed','human_handoff','nurture','lost','do_not_contact','removed_by_request']
    when 'nurture' then array['responded','qualified','dormant','lost','do_not_contact','removed_by_request']
    when 'checkout_pushed' then array['payment_pending','won','human_handoff','lost','do_not_contact','removed_by_request']
    when 'payment_pending' then array['won','human_handoff','lost','do_not_contact','removed_by_request']
    when 'human_handoff' then array['responded','qualified','checkout_pushed','payment_pending','won','nurture','lost','do_not_contact','removed_by_request']
    when 'won' then array['onboarding_active','active_student']
    when 'lost' then array['nurture','dormant']
    when 'dormant' then array['responded','nurture','lost']
    when 'onboarding_active' then array['active_student']
    when 'manual_review_required' then array['first_contact_sent','human_handoff','lost','do_not_contact']
    else array[]::text[]
  end;

  if p_target = v_current then
    select * into v_lead from leads where id = p_lead_id;
    return v_lead;
  end if;

  if not p_target = any(v_legal) then
    insert into lead_events(lead_id, event_type, actor_type, event_payload)
    values (p_lead_id, 'state_transition_rejected', p_actor_type,
            jsonb_build_object('from', v_current, 'to', p_target, 'reason', p_reason));
    return null;
  end if;

  update leads set lead_status = p_target, updated_at = now() where id = p_lead_id
    returning * into v_lead;

  insert into lead_events(lead_id, event_type, actor_type, event_payload)
  values (p_lead_id, 'lead_status_changed', p_actor_type,
          jsonb_build_object('from', v_current, 'to', p_target, 'reason', p_reason));

  return v_lead;
end;
$$;
revoke all on function public.transition_lead_status(uuid,text,text,text) from public;
grant execute on function public.transition_lead_status(uuid,text,text,text) to service_role;
