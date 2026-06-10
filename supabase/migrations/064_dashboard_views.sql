-- 064_dashboard_views.sql
--
-- Tier 3 — aggregate views feeding the 3 missing dashboards
-- (commissions, presale, retention). Sales + ops already have their
-- own surface via DashboardPage; this migration fills the gap.
--
-- All views are plain views (not materialised). The aggregates are
-- cheap because the underlying tables are small and well-indexed;
-- a materialised view would need a refresh schedule and would lie
-- about "fresh" data for the lag window. Until volume forces us to
-- materialise, freshness > throughput.

-- ─────────────────────────────────────────────────────────────────────
-- Commissions: aggregate health by month + by partner.
-- ─────────────────────────────────────────────────────────────────────

-- One row per (month, status). Drives the trend chart on the
-- commissions dashboard. Months are truncated to first-of-month
-- (UTC) so the chart's x-axis is regular.
create or replace view public.commission_monthly as
  select
    date_trunc('month', c.pending_at) as month,
    c.status,
    count(*)::int as count,
    sum(coalesce(c.amount_received, c.amount_due))::numeric as amount_total
  from public.commissions c
  group by 1, 2;

grant select on public.commission_monthly to authenticated, service_role;

-- One row per partner with their lifetime + last-90-days totals.
-- Drives the "top earners" leaderboard on the commissions dashboard
-- AND informs the partner workload card on /partners.
create or replace view public.commission_by_partner as
  select
    p.id as partner_id,
    p.full_name,
    p.domain,
    p.commission_to_karnaf_pct,
    count(c.*)::int as commissions_count,
    count(*) filter (where c.status = 'paid')::int as paid_count,
    count(*) filter (where c.status in ('pending', 'to_bill'))::int as open_count,
    coalesce(sum(c.amount_received) filter (where c.status = 'paid'), 0)::numeric as paid_total,
    coalesce(sum(c.amount_due) filter (where c.status in ('pending', 'to_bill')), 0)::numeric as open_total,
    -- Days-to-pay average for paid rows. Mia uses this to spot slow
    -- partners — long DTP = follow-up problem.
    (avg(extract(epoch from (c.paid_at - c.pending_at)) / 86400)
      filter (where c.status = 'paid'))::numeric as avg_days_to_paid
  from public.partners p
  left join public.commissions c on c.partner_id = p.id
  group by p.id, p.full_name, p.domain, p.commission_to_karnaf_pct;

grant select on public.commission_by_partner to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- Presale: risk index + per-project conversion.
-- ─────────────────────────────────────────────────────────────────────

-- Projects at risk = recruiting + target_date approaching + funding
-- below 80% of target. Drives the dashboard's red-list.
create or replace view public.presale_at_risk as
  select
    p.id as project_id,
    p.name,
    p.city,
    p.target_date,
    p.target_amount,
    p.currency,
    pfp.committed_amount,
    pfp.funding_pct,
    -- Days remaining until target_date. Negative = past due.
    case when p.target_date is null then null
         else (p.target_date - current_date) end as days_to_target,
    -- A simple risk flag the UI can render straight as red/amber.
    case
      when p.target_date is not null and p.target_date < current_date then 'overdue'
      when p.target_date is not null and p.target_date < current_date + interval '14 days'
           and coalesce(pfp.funding_pct, 0) < 80 then 'red'
      when coalesce(pfp.funding_pct, 0) < 50 then 'amber'
      else 'ok'
    end as risk_level
  from public.projects p
  left join public.project_funding_progress pfp on pfp.project_id = p.id
  where p.status = 'recruiting';

grant select on public.presale_at_risk to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- Retention: program members by progress stage + dormancy rate.
-- ─────────────────────────────────────────────────────────────────────

-- One row per progress stage with active vs dormant counts. Dormant
-- here = no message activity in 30+ days (matches the lead-level
-- dormancy heuristic the sla-worker uses).
create or replace view public.retention_program_stages as
  with member_last_activity as (
    select
      pm.lead_id,
      pm.progress_stage,
      pm.joined_at,
      coalesce(
        (select max(occurred_at) from public.activities a where a.contact_id = pm.lead_id),
        pm.joined_at
      ) as last_activity_at
    from public.program_members pm
  )
  select
    progress_stage,
    count(*)::int as members_count,
    count(*) filter (where last_activity_at > now() - interval '30 days')::int as active_count,
    count(*) filter (where last_activity_at <= now() - interval '30 days')::int as dormant_count,
    -- Round to a tenth so the UI's "% active" reads cleanly.
    case when count(*) = 0 then null
         else round(
           100.0 * count(*) filter (where last_activity_at > now() - interval '30 days') / count(*),
           1
         )
    end as active_pct
  from member_last_activity
  group by progress_stage;

grant select on public.retention_program_stages to authenticated, service_role;

comment on view public.commission_monthly is
  'Tier 3 dashboard view — commission counts + totals per (month, status).';
comment on view public.commission_by_partner is
  'Tier 3 dashboard view — per-partner commission rollup + avg days-to-paid.';
comment on view public.presale_at_risk is
  'Tier 3 dashboard view — recruiting projects with computed risk_level (ok/amber/red/overdue).';
comment on view public.retention_program_stages is
  'Tier 3 dashboard view — program_members by progress stage with 30d active/dormant split.';
