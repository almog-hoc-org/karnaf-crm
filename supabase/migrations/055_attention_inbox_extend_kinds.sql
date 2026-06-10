-- 055_attention_inbox_extend_kinds.sql
--
-- Tier 0.C of the v4 redesign: surface the new "fall-between-chairs"
-- watchers (added in sla-worker for Tier 0.B) as distinct inbox kinds so
-- Mia can filter by them in the /inbox UI. Without this, every new
-- watcher just shows up as a generic 'queue' row and the morning view
-- is back to looking like an undifferentiated list.
--
-- The RPC keeps the same return shape — the existing client code does
-- not need to change to keep working; it just gains the ability to
-- group by the new kind values.

create or replace function public.attention_inbox(p_limit int default 200)
returns table (
  kind text,
  ref_id uuid,
  lead_id uuid,
  lead_name text,
  lead_phone text,
  lead_status text,
  lead_heat text,
  ownership_mode text,
  priority_level int,
  reason text,
  due_at timestamptz,
  created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  with q as (
    select
      -- Map specific queue_type values to their own kind so the UI can
      -- chip-filter them; fall back to generic 'queue' for the rest.
      case w.queue_type
        when 'deal_stalled' then 'deal_stalled'
        when 'meeting_outcome_pending' then 'meeting_outcome_pending'
        when 'phone_overdue' then 'phone_overdue'
        when 'ai_stuck' then 'ai_stuck'
        when 'phone_escalation' then 'phone_escalation'
        else 'queue'
      end::text as kind,
      w.id as ref_id,
      w.lead_id,
      l.full_name as lead_name,
      l.phone as lead_phone,
      l.lead_status::text as lead_status,
      l.lead_heat::text as lead_heat,
      l.ownership_mode::text as ownership_mode,
      w.priority_level,
      coalesce(w.reason, w.queue_type) as reason,
      w.due_at,
      w.created_at
    from work_queue w
    join leads l on l.id = w.lead_id
    where w.status in ('pending','claimed')
  ),
  mia_pending as (
    select
      'mia_reply'::text as kind,
      l.id as ref_id,
      l.id as lead_id,
      l.full_name as lead_name,
      l.phone as lead_phone,
      l.lead_status::text as lead_status,
      l.lead_heat::text as lead_heat,
      l.ownership_mode::text as ownership_mode,
      2 as priority_level,
      'הלקוח השיב — נדרשת תגובה ידנית'::text as reason,
      l.last_inbound_at as due_at,
      l.last_inbound_at as created_at
    from leads l
    where l.ownership_mode = 'mia_active'
      and l.last_inbound_at is not null
      and (l.last_outbound_at is null or l.last_outbound_at < l.last_inbound_at)
      and coalesce(l.do_not_contact, false) = false
      and coalesce(l.removed_by_request, false) = false
  ),
  overdue_action as (
    select
      'overdue_action'::text as kind,
      l.id as ref_id,
      l.id as lead_id,
      l.full_name as lead_name,
      l.phone as lead_phone,
      l.lead_status::text as lead_status,
      l.lead_heat::text as lead_heat,
      l.ownership_mode::text as ownership_mode,
      1 as priority_level,
      coalesce('פעולה הבאה באיחור: ' || nullif(l.next_action_type, ''), 'פעולה הבאה באיחור') as reason,
      l.next_action_due_at as due_at,
      l.next_action_due_at as created_at
    from leads l
    where l.next_action_due_at is not null
      and l.next_action_due_at < now()
      and l.lead_status not in ('won','lost','do_not_contact','removed_by_request')
  ),
  unioned as (
    select * from q
    union all select * from mia_pending
    union all select * from overdue_action
  )
  select * from unioned
  order by priority_level asc, due_at asc nulls last, created_at desc
  limit p_limit;
$$;

revoke all on function public.attention_inbox(int) from public;
grant execute on function public.attention_inbox(int) to authenticated, service_role;
