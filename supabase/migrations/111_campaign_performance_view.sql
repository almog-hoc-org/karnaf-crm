-- 111_campaign_performance_view.sql
--
-- Campaign-grained analytics: like v_source_performance but keyed on the
-- real ad campaign — utm_campaign (first-touch, from 110) with
-- source_campaign as fallback for leads without UTM data.

create or replace view v_campaign_performance as
select
  coalesce(nullif(utm_campaign, ''), nullif(source_campaign, '')) as campaign,
  count(*)::int as leads_total,
  count(*) filter (where lead_status not in ('new'))::int as leads_engaged,
  count(*) filter (where lead_status = 'qualified')::int as leads_qualified,
  count(*) filter (where lead_status = 'won')::int as leads_won,
  count(*) filter (where payment_status = 'paid')::int as leads_paid,
  case when count(*) > 0
       then round(100.0 * count(*) filter (where lead_status = 'won') / count(*), 2)
       else 0 end as win_rate_pct,
  min(created_at) as first_lead_at,
  max(created_at) as last_lead_at
from leads
where coalesce(nullif(utm_campaign, ''), nullif(source_campaign, '')) is not null
group by 1;
