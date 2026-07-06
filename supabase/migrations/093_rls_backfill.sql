-- 093_rls_backfill.sql
--
-- Close the RLS gap on the 16 tables created without row level security
-- (audit 2026-07-06, post-PR-#44 review). Until this migration, anyone
-- holding the public anon key — which ships inside the web bundle — could
-- read AND write these tables straight through PostgREST: the paying-member
-- roster (program_members), the full deal book (deals), the outbound queue
-- (outbound_dispatch), and more.
--
-- Two access classes:
--
--   1. Infra / queue tables no human ever reads from the browser:
--      RLS enabled with NO policy for `authenticated`. The service-role
--      client (all edge functions) bypasses RLS, so workers are unaffected;
--      everyone else gets zero rows.
--
--   2. Staff data tables: RLS + the standard is_active_staff() policy,
--      same shape as 067_customer_journeys.sql. Operators keep full access
--      through their JWT; anon gets nothing.
--
-- Safety audit before writing this file:
--   * The only request-scoped (RLS-subject) client in edge functions is
--     requireStaff's profile lookup (_shared/auth.ts) — `profiles` already
--     has RLS from 005. Every other table access uses the service client.
--   * The frontend queries exactly two tables directly: profiles and
--     system_heartbeats — both already policied (005 / 079).
--   => enabling RLS below breaks no existing consumer.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Service-role-only infra tables: lock completely.
-- ─────────────────────────────────────────────────────────────────────
alter table public.webhook_rate_limit     enable row level security;
alter table public.job_runs               enable row level security;
alter table public.webhook_inbox          enable row level security;
alter table public.webhook_idempotency    enable row level security;
alter table public.outbound_dispatch      enable row level security;
alter table public.whatsapp_router_state  enable row level security;

grant select, insert, update, delete on public.webhook_rate_limit    to service_role;
grant select, insert, update, delete on public.job_runs              to service_role;
grant select, insert, update, delete on public.webhook_inbox         to service_role;
grant select, insert, update, delete on public.webhook_idempotency   to service_role;
grant select, insert, update, delete on public.outbound_dispatch     to service_role;
grant select, insert, update, delete on public.whatsapp_router_state to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Staff data tables: is_active_staff() read/write.
-- ─────────────────────────────────────────────────────────────────────
alter table public.lead_sources             enable row level security;
alter table public.pending_manual_replies   enable row level security;
alter table public.deals                    enable row level security;
alter table public.meetings                 enable row level security;
alter table public.webinars                 enable row level security;
alter table public.webinar_registrations    enable row level security;
alter table public.program_members          enable row level security;
alter table public.whatsapp_router_options  enable row level security;
alter table public.deal_stage_history       enable row level security;
alter table public.intake_source_contracts  enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'lead_sources',
    'pending_manual_replies',
    'deals',
    'meetings',
    'webinars',
    'webinar_registrations',
    'program_members',
    'whatsapp_router_options',
    'deal_stage_history',
    'intake_source_contracts'
  ] loop
    execute format('drop policy if exists %I_staff_all on public.%I', t, t);
    execute format(
      'create policy %I_staff_all on public.%I
         for all to authenticated
         using (public.is_active_staff())
         with check (public.is_active_staff())',
      t, t
    );
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;
