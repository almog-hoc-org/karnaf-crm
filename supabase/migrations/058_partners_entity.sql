-- 058_partners_entity.sql
--
-- Tier 1.A — Partner entity for the investor-mentorship track and the
-- (smaller) presale partner network. The v4 spec § ד5 calls these
-- "פרילנסר": external service providers who close on behalf of Karnaf
-- and earn a commission percentage on signed deals.
--
-- Until now `deals.partner_name` was a free-text shadow. That made
-- three things impossible:
--   1. Workload routing — automation B3 "shibutz freelancer" needs to
--      pick the partner with the fewest open deals.
--   2. Commission accounting — the % belongs on the Partner record so
--      it can change once without rewriting every closed deal.
--   3. Partner-scoped UI — eventually a partner logs in and sees only
--      their own pipeline.
--
-- Schema choice: `domain` is open text rather than an enum because the
-- spec's four values (ליווי משקיעים / שמאות / משפטי / מימון) are
-- likely to grow as Karnaf onboards more service providers. The check
-- constraint enforces the current allow-list; loosen later if needed.
--
-- profiles.id FK on user_id is nullable: most partners will not have a
-- CRM login at first (they get assigned via WhatsApp). When/if a
-- partner sso flow lands, set user_id and the RLS policy below scopes
-- them to their own row + deals.

create table if not exists public.partners (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text,
  email text,
  domain text not null check (domain in (
    'investor_mentorship', 'appraisal', 'legal', 'financing', 'other'
  )),
  -- % of deal value that goes to Karnaf. Stored as e.g. 30.00 = 30%.
  -- The complement (1 - commission_to_karnaf_pct/100) is the partner's
  -- take. Keeping Karnaf's slice (rather than the partner's) on this
  -- record because that's the number that appears on Karnaf's books.
  commission_to_karnaf_pct numeric(5,2) not null default 0
    check (commission_to_karnaf_pct >= 0 and commission_to_karnaf_pct <= 100),
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  -- Optional login binding for the future partner portal. Mia and
  -- admins can set this later when a partner asks for access.
  user_id uuid references public.profiles(id) on delete set null,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Lookup by login + by domain (for the assignment automation).
create index if not exists idx_partners_user on public.partners(user_id) where user_id is not null;
create index if not exists idx_partners_active_domain on public.partners(domain, status)
  where status = 'active';
-- Phone uniqueness is soft: two partners can share a phone in edge
-- cases (shared agency line). Enforce it as a non-unique index instead.
create index if not exists idx_partners_phone on public.partners(phone) where phone is not null;

-- ─────────────────────────────────────────────────────────────────────
-- updated_at trigger — same pattern as the rest of the schema.
-- ─────────────────────────────────────────────────────────────────────
drop trigger if exists trg_partners_updated_at on public.partners;
create trigger trg_partners_updated_at
  before update on public.partners
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- RLS — staff (owner/admin/mia) can read+write everyone; a partner
-- with user_id matching auth.uid() can read their own row only. They
-- can't read other partners' commissions and can't edit anything.
-- ─────────────────────────────────────────────────────────────────────
alter table public.partners enable row level security;

drop policy if exists partners_staff_all on public.partners;
create policy partners_staff_all on public.partners
  for all to authenticated
  using (public.is_active_staff())
  with check (public.is_active_staff());

drop policy if exists partners_self_read on public.partners;
create policy partners_self_read on public.partners
  for select to authenticated
  using (user_id is not null and user_id = auth.uid());

grant select, insert, update, delete on public.partners to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- Workload view — how many open deals does each active partner have?
-- This is the input for the B3 assignment automation (pick the
-- partner with the lowest current workload).
--
-- A view (not a materialized view) so it stays current without a
-- refresh schedule. The query is cheap once deals.partner_id has its
-- index from 059.
-- ─────────────────────────────────────────────────────────────────────
create or replace view public.partner_workload as
  select
    p.id as partner_id,
    p.full_name,
    p.domain,
    p.commission_to_karnaf_pct,
    p.status,
    -- partner_id FK on deals lands in migration 059; until then this
    -- count silently stays at 0 for everyone, which is correct: the
    -- text shadow `deals.partner_name` is intentionally NOT bridged
    -- into this view because it would give misleading workload
    -- numbers based on string equality.
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
  'Tier 1.A — read-side aggregate driving the partner-assignment '
  'automation. open_deals_count picks the freelancer with the most '
  'bandwidth; won_deals_count surfaces in the partner card UI as a '
  'lightweight reputation signal.';
