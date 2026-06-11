-- 079_system_heartbeats.sql
--
-- Tier 7.B.3 + 7.B.5 — observability scaffolding.
--
-- ## Heartbeats
--
-- pg_cron drift, URL config loss, or a one-line edge fn bug can take
-- the automation tick offline with zero visibility. Until now an
-- admin would notice "no welcome messages are going out" days after
-- the fact, when a customer complained.
--
-- `system_heartbeats` is a tiny table — one row per named worker
-- (automation_tick, sla_worker, daily_sales_inbox). The worker
-- upserts its row at the end of a successful run. The Dashboard reads
-- it and shows a red banner if the last successful tick was more than
-- 15 minutes ago.
--
-- ## Composite tick index
--
-- Same migration adds a partial index on leads matching the tick's
-- scan filter. Cheap insurance: at 500-row scan + 5-condition filter
-- + sort, Postgres would full-table scan worst case. The partial
-- index covers the hot path.

create table if not exists public.system_heartbeats (
  name text primary key,
  last_ok_at timestamptz not null,
  last_run_id text,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_system_heartbeats_updated_at on public.system_heartbeats;
create trigger trg_system_heartbeats_updated_at
  before update on public.system_heartbeats
  for each row execute function public.set_updated_at();

alter table public.system_heartbeats enable row level security;

drop policy if exists system_heartbeats_staff_read on public.system_heartbeats;
create policy system_heartbeats_staff_read on public.system_heartbeats
  for select to authenticated using (public.is_active_staff());

grant select, insert, update on public.system_heartbeats to service_role;

comment on table public.system_heartbeats is
  'Tier 7.B.3 — last successful run timestamp per cron worker. '
  'Dashboard shows red banner if last_ok_at is older than 15 min.';

-- ─────────────────────────────────────────────────────────────────────
-- 7.B.5 — partial index for the automation-tick leads scan.
-- ─────────────────────────────────────────────────────────────────────
create index if not exists idx_leads_tick_active
  on public.leads (created_at)
  where do_not_contact = false
    and removed_by_request = false
    and lead_status not in ('won', 'lost', 'suppressed', 'do_not_contact', 'removed_by_request')
    and ownership_mode not in ('mia_active', 'phone_sales_pending');
