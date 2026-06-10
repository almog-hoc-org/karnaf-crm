-- 060_deals_link_partner_project.sql
--
-- Tier 1.C — turn `deals.partner_name` and `deals.presale_project`
-- from TEXT shadows into real FKs. The text columns stay for one
-- release as a fallback (read-only), then drop in a Tier 2 cleanup
-- migration.
--
-- Backfill strategy: greedy match. For each open/won deal with a
-- non-empty partner_name (or presale_project), try to find an
-- existing partner (or project) whose full_name (or name) matches
-- case-insensitively. Matched → link. Unmatched → create a stub row
-- so no historical data goes silent, and a Mia/admin can finish the
-- record (commission %, city, etc.) later.
--
-- This is destructive-ish: a stub partner gets `commission_to_karnaf_pct=0`
-- so until someone fills it in, the commission calc reads as zero.
-- Almog's carte blanche on data (see feedback-karnaf-crm-data-blanche)
-- makes this the right trade-off — accurate model wins over preserved
-- text approximation.

alter table public.deals
  add column if not exists partner_id uuid references public.partners(id) on delete set null,
  add column if not exists project_id uuid references public.projects(id) on delete set null;

create index if not exists idx_deals_partner_status on public.deals(partner_id, status)
  where partner_id is not null;
create index if not exists idx_deals_project_status on public.deals(project_id, status)
  where project_id is not null;

-- ─────────────────────────────────────────────────────────────────────
-- Backfill partners. CTE walks the distinct partner_name strings on
-- deals, tries to find a match in partners (case + trim insensitive),
-- otherwise creates a stub row, then updates the deals to point at the
-- resolved id.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  raw_name text;
  resolved_id uuid;
begin
  for raw_name in
    select distinct trim(partner_name)
    from public.deals
    where partner_name is not null
      and length(trim(partner_name)) > 0
      and partner_id is null
  loop
    -- Try exact (case-insensitive) match first.
    select id into resolved_id
    from public.partners
    where lower(full_name) = lower(raw_name)
    limit 1;

    if resolved_id is null then
      -- Stub row: keeps the historical link visible, commission flat
      -- at 0 until a human fills it in. Domain defaults to investor
      -- mentorship since that's the only track the spec assigns a
      -- partner to today.
      insert into public.partners (full_name, domain, status, notes)
      values (raw_name, 'investor_mentorship', 'active',
              'נוצר אוטומטית במיגרציה 060 מהשדה deals.partner_name. השלם פרטים.')
      returning id into resolved_id;
    end if;

    update public.deals
       set partner_id = resolved_id
     where partner_id is null
       and lower(trim(partner_name)) = lower(raw_name);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- Backfill projects. Same shape; presale_project → projects.name.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  raw_name text;
  resolved_id uuid;
begin
  for raw_name in
    select distinct trim(presale_project)
    from public.deals
    where presale_project is not null
      and length(trim(presale_project)) > 0
      and project_id is null
  loop
    select id into resolved_id
    from public.projects
    where lower(name) = lower(raw_name)
    limit 1;

    if resolved_id is null then
      insert into public.projects (name, project_type, status, notes)
      values (raw_name, 'residential', 'recruiting',
              'נוצר אוטומטית במיגרציה 060 מהשדה deals.presale_project. השלם פרטים.')
      returning id into resolved_id;
    end if;

    update public.deals
       set project_id = resolved_id
     where project_id is null
       and lower(trim(presale_project)) = lower(raw_name);
  end loop;
end $$;

comment on column public.deals.partner_id is
  'Tier 1.C FK to partners. partner_name (text) is the legacy shadow '
  'kept read-only for one release; new code reads partner_id and '
  'joins to partners for commission/workload data.';
comment on column public.deals.project_id is
  'Tier 1.C FK to projects. presale_project (text) is the legacy '
  'shadow kept read-only for one release.';

-- ─────────────────────────────────────────────────────────────────────
-- partner_workload view — moved here from 058 because it depends on
-- deals.partner_id which we just created above. Drives the B3
-- assignment automation: pick the freelancer with the lowest open
-- count.
-- ─────────────────────────────────────────────────────────────────────
create or replace view public.partner_workload as
  select
    p.id as partner_id,
    p.full_name,
    p.domain,
    p.commission_to_karnaf_pct,
    p.status,
    (
      select count(*)::int from public.deals d
      where d.status = 'open' and d.partner_id = p.id
    ) as open_deals_count,
    (
      select count(*)::int from public.deals d
      where d.status = 'won' and d.partner_id = p.id
    ) as won_deals_count
  from public.partners p;

grant select on public.partner_workload to authenticated, service_role;

comment on view public.partner_workload is
  'Tier 1.A/C — read-side aggregate driving the partner-assignment '
  'automation. open_deals_count picks the freelancer with the most '
  'bandwidth; won_deals_count surfaces in the partner card UI as a '
  'lightweight reputation signal.';

-- Same shape on the project side: project_funding_progress depends on
-- deals.project_id. Created in 059 but re-defining here for safety —
-- the OR REPLACE makes it idempotent.
create or replace view public.project_funding_progress as
  select
    p.id as project_id,
    p.name,
    p.city,
    p.total_units,
    p.price_per_unit,
    p.target_amount,
    p.currency,
    p.status,
    p.target_date,
    (
      select coalesce(sum(d.value), 0)::numeric from public.deals d
      where d.project_id = p.id and d.status in ('open', 'won')
    ) as committed_amount,
    (
      select count(*)::int from public.deals d
      where d.project_id = p.id and d.status in ('open', 'won')
    ) as committed_units,
    case
      when p.target_amount is null or p.target_amount = 0 then null
      else round(
        100.0 * (
          select coalesce(sum(d.value), 0) from public.deals d
          where d.project_id = p.id and d.status in ('open', 'won')
        ) / p.target_amount,
        1
      )
    end as funding_pct
  from public.projects p;

grant select on public.project_funding_progress to authenticated, service_role;
