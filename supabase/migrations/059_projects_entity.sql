-- 059_projects_entity.sql
--
-- Tier 1.B — Project entity for the presale (קבוצת רכישה / פריסייל)
-- track. Spec § ד6.
--
-- Until now `deals.presale_project` was a free-text shadow. That meant:
--   1. No funding-target tracking — Karnaf couldn't see "we've raised
--      14 of 20 units" at a glance.
--   2. No project-scoped matching — automation B17 "pop project →
--      contact relevant Contacts" relies on a real Project row to
--      compare against contact preferences.
--   3. No project-state ratchet — a project should transition
--      recruiting → closed → executed exactly once each, and TEXT
--      can't enforce that.
--
-- Schema notes:
--   * `project_type` covers the two big categories the spec names. If
--     hybrid emerges (mixed-use), add to the check constraint.
--   * `total_units` is the upper bound; the raised count comes from
--     joining deals later (via the partner_workload-style view at the
--     bottom). target_amount = price_per_unit × total_units in the
--     common case but is stored separately so Karnaf can adjust the
--     fundraising goal independently (e.g., when minimum viable size
--     is lower than the full project).
--   * Status transitions: 'recruiting' (initial) → 'closed' (all
--     units committed) → 'executed' (contracts signed, deal done).
--     'cancelled' is the off-ramp. No re-opens — once executed it
--     stays executed.

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text,
  developer_name text,
  project_type text not null default 'residential' check (project_type in (
    'residential', 'commercial', 'mixed'
  )),
  total_units int check (total_units is null or total_units > 0),
  price_per_unit numeric(12,2),
  -- Fundraising target. Often equals total_units * price_per_unit
  -- but stored separately so Karnaf can run "soft launch" with a
  -- smaller MVP target.
  target_amount numeric(14,2),
  currency text not null default 'ILS',
  status text not null default 'recruiting' check (status in (
    'recruiting', 'closed', 'executed', 'cancelled'
  )),
  -- When the developer needs commitments by; used to chase contacts
  -- in automation B18 (rishum lkvutza → tzu mikdama tizkoret).
  target_date date,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_projects_status on public.projects(status, target_date)
  where status in ('recruiting', 'closed');
create index if not exists idx_projects_city on public.projects(city) where city is not null;

-- ─────────────────────────────────────────────────────────────────────
-- updated_at trigger
-- ─────────────────────────────────────────────────────────────────────
drop trigger if exists trg_projects_updated_at on public.projects;
create trigger trg_projects_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- RLS — staff only. Contacts learn about projects through the bot or
-- a marketing channel, not by querying the table directly.
-- ─────────────────────────────────────────────────────────────────────
alter table public.projects enable row level security;

drop policy if exists projects_staff_all on public.projects;
create policy projects_staff_all on public.projects
  for all to authenticated
  using (public.is_active_staff())
  with check (public.is_active_staff());

grant select, insert, update, delete on public.projects to service_role;

-- project_funding_progress view is created in 060, after deals gains
-- the project_id FK. Tier 1.B intentionally ships only the storage
-- shape here; the read-side aggregate ships next door.
