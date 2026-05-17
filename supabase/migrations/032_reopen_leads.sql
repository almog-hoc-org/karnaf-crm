-- 032_reopen_leads.sql
-- Allow owner/admin to reopen a closed lead (won/lost) back into an active
-- pipeline stage. The base transition table forbids the move; this RPC is the
-- audited escape hatch. Additive only: existing transition_lead_status is
-- untouched and continues to enforce the normal state-machine for AI / Mia.

create or replace function public.reopen_lead(
  p_lead_id uuid,
  p_target_status text,
  p_actor_role text,
  p_reason text default null,
  p_actor_user_id uuid default null
) returns leads
language plpgsql security definer set search_path = public as $$
declare
  v_current text;
  v_legal_targets text[] := array['responded','qualified','nurture','human_handoff'];
  v_lead leads;
  v_event_payload jsonb;
begin
  -- Role gate: only owners/admins can override the closed state.
  if p_actor_role is null or p_actor_role not in ('owner','admin') then
    raise exception 'reopen_lead requires owner or admin role (got: %)', coalesce(p_actor_role,'null');
  end if;

  if p_target_status is null or not (p_target_status = any (v_legal_targets)) then
    raise exception 'reopen_lead target % is not one of %', p_target_status, v_legal_targets;
  end if;

  select lead_status into v_current from leads where id = p_lead_id for update;
  if v_current is null then
    return null;
  end if;
  if v_current not in ('won','lost') then
    raise exception 'reopen_lead requires a closed lead (current: %)', v_current;
  end if;

  -- Clear closure timestamps without touching payment_status / payments
  -- already recorded — those remain for accounting truth.
  if v_current = 'won' then
    update leads set won_at = null where id = p_lead_id;
  elsif v_current = 'lost' then
    update leads set lost_at = null, lost_reason = null where id = p_lead_id;
  end if;

  update leads set lead_status = p_target_status, updated_at = now()
    where id = p_lead_id
    returning * into v_lead;

  v_event_payload := jsonb_build_object(
    'from', v_current,
    'to', p_target_status,
    'reason', p_reason,
    'actor_user_id', p_actor_user_id
  );

  insert into lead_events(lead_id, event_type, actor_type, actor_id, event_payload)
  values (p_lead_id, 'lead_reopened', p_actor_role, p_actor_user_id, v_event_payload);

  -- Also log a regular status change for downstream consumers that listen
  -- on lead_status_changed events.
  insert into lead_events(lead_id, event_type, actor_type, actor_id, event_payload)
  values (p_lead_id, 'lead_status_changed', p_actor_role, p_actor_user_id, v_event_payload);

  return v_lead;
end;
$$;

revoke all on function public.reopen_lead(uuid, text, text, text, uuid) from public;
grant execute on function public.reopen_lead(uuid, text, text, text, uuid) to service_role;
