-- 033_attention_inbox.sql
-- Unified "needs attention" inbox + per-source health on dashboard summary.
-- Additive only: existing dashboard_summary() is replaced with a superset.

-- Items demanding human attention, unioned from three sources:
--  1. Open work_queue rows (pending or claimed)
--  2. Leads where Mia owes a reply (mia_active and lead has spoken last)
--  3. Leads with an overdue next_action_due_at
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
      'queue'::text as kind,
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

-- Extend dashboard_summary with sourceHealth: 24h + 7d intake counts per source.
create or replace function public.dashboard_summary() returns jsonb
language sql stable security definer set search_path = public as $$
  with funnel as (select * from v_conversion_funnel),
       today_leads as (
         select count(*)::int as c from leads where created_at::date = current_date
       ),
       unanswered as (
         select count(*)::int as c from leads
         where lead_status in ('new','first_contact_sent')
           and coalesce(do_not_contact,false) = false
           and coalesce(removed_by_request,false) = false
       ),
       hot as (
         select count(*)::int as c from leads
         where lead_heat = 'hot'
           and lead_status not in ('won','lost','do_not_contact','removed_by_request')
       ),
       payment_pending as (
         select count(*)::int as c from leads where lead_status = 'payment_pending'
       ),
       sla_at_risk as (
         select count(*)::int as c from leads
         where last_inbound_at is not null
           and (last_outbound_at is null or last_outbound_at < last_inbound_at)
           and last_inbound_at < now() - interval '8 hours'
           and coalesce(do_not_contact,false) = false
           and coalesce(removed_by_request,false) = false
       ),
       queue_counts as (
         select queue_type, count(*)::int as c from work_queue where status = 'pending' group by queue_type
       ),
       sources_24h as (
         select source, count(*)::int as c
         from leads where created_at >= now() - interval '24 hours' group by source
       ),
       sources_7d as (
         select source, count(*)::int as c
         from leads where created_at >= now() - interval '7 days' group by source
       ),
       all_sources as (
         select source from sources_7d
         union select source from sources_24h
       ),
       source_health as (
         select s.source,
                coalesce((select c from sources_24h x where x.source = s.source), 0) as h24,
                coalesce((select c from sources_7d x where x.source = s.source), 0) as d7
         from all_sources s
         where s.source is not null
       )
  select jsonb_build_object(
    'leadsToday', (select c from today_leads),
    'unansweredNow', (select c from unanswered),
    'hotLeadsNow', (select c from hot),
    'paymentPendingNow', (select c from payment_pending),
    'slaRiskCount', (select c from sla_at_risk),
    'funnel', to_jsonb((select f from funnel f)),
    'queueCounts', coalesce((select jsonb_object_agg(queue_type, c) from queue_counts), '{}'::jsonb),
    'sourceHealth', coalesce(
      (select jsonb_object_agg(source, jsonb_build_object('h24', h24, 'd7', d7)) from source_health),
      '{}'::jsonb
    )
  );
$$;

revoke all on function public.dashboard_summary() from public;
grant execute on function public.dashboard_summary() to authenticated, service_role;
