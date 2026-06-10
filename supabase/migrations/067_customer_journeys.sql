-- 067_customer_journeys.sql
--
-- Tier 4.B — customer journeys.
--
-- A journey is an ordered sequence of action-bundles with delays
-- between them, tracked per-contact. Examples from spec § ח:
--
--   * Program 14-day: welcome → check-in day 1 → motivation day 3 →
--     feedback day 7 → graduation day 14.
--   * Investor mentorship: kickoff → partner assigned → first meeting
--     reminder → status checkpoint.
--   * Retention: course-stalled nudge → mentor offer → reactivate.
--
-- Two tables:
--   journey_definitions — the recipe. Steps live in a jsonb array so
--     a non-coder can edit cadence/copy via the /journeys page later.
--   journey_runs — one row per (contact × definition) instance.
--     Tracks current_step + scheduled_next_at so the cron tick knows
--     which contacts are due for advancement.
--
-- The engine connects them through a new `journey_start` action.
-- A rule whose actions include {"type":"journey_start","code":"x"}
-- inserts a journey_runs row and schedules step 0. The journey-runner
-- (called from automation-tick) advances each due run by:
--   1. running the current step's actions through the engine,
--   2. computing next step's scheduled_next_at by adding its delay,
--   3. bumping current_step + persisting state.
-- When current_step passes the last step, status → completed.

-- ─────────────────────────────────────────────────────────────────────
-- Definition: the recipe. Steps is an array of:
--   {
--     "name": "day_0_welcome",
--     "delay_hours": 0,        -- delay from the *previous* step
--     "conditions": {},        -- optional; if it doesn't match,
--                              -- step is skipped (logged) and runner
--                              -- moves to the next.
--     "actions": [...]         -- engine action objects
--   }
-- The very first step's delay_hours is the delay from journey start.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.journey_definitions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_he text not null,
  description text,
  trigger_event text not null,
  -- Optional gating conditions evaluated at start time. If they
  -- don't match, the journey_start action no-ops and logs a skip.
  trigger_conditions jsonb not null default '{}'::jsonb,
  steps jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  -- 'allow_concurrent' = false means if a contact already has an
  -- active run of this journey, journey_start no-ops instead of
  -- creating a duplicate. Almost always what you want.
  allow_concurrent boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_journey_definitions_updated_at on public.journey_definitions;
create trigger trg_journey_definitions_updated_at
  before update on public.journey_definitions
  for each row execute function public.set_updated_at();

alter table public.journey_definitions enable row level security;

drop policy if exists journey_definitions_staff_all on public.journey_definitions;
create policy journey_definitions_staff_all on public.journey_definitions
  for all to authenticated
  using (public.is_active_staff())
  with check (public.is_active_staff());

grant select, insert, update, delete on public.journey_definitions to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- Runs: one row per active (contact × definition) instance.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.journey_runs (
  id uuid primary key default gen_random_uuid(),
  definition_id uuid not null references public.journey_definitions(id) on delete cascade,
  -- Definition code snapshot so the audit row stays legible even
  -- after a definition is later renamed/deleted.
  definition_code text not null,
  contact_id uuid not null references public.leads(id) on delete cascade,
  -- 0-indexed pointer into definition.steps. When current_step >=
  -- length(steps) and runner advances, status becomes 'completed'.
  current_step int not null default 0,
  state jsonb not null default '{}'::jsonb,
  -- The next time the runner should attempt to advance. Indexed for
  -- the cron tick's "where due" scan.
  scheduled_next_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  -- Optional reason a failed run gives up — populated when an
  -- action returns failed and the runner decides to halt vs retry.
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Critical: runner scan filter.
create index if not exists idx_journey_runs_due
  on public.journey_runs(scheduled_next_at)
  where status = 'active';

-- Per-contact lookup for "what journeys is this lead in?".
create index if not exists idx_journey_runs_contact
  on public.journey_runs(contact_id, status);

-- For the no-concurrent guard at start time.
create index if not exists idx_journey_runs_dedup
  on public.journey_runs(definition_id, contact_id, status)
  where status = 'active';

drop trigger if exists trg_journey_runs_updated_at on public.journey_runs;
create trigger trg_journey_runs_updated_at
  before update on public.journey_runs
  for each row execute function public.set_updated_at();

alter table public.journey_runs enable row level security;

drop policy if exists journey_runs_staff_all on public.journey_runs;
create policy journey_runs_staff_all on public.journey_runs
  for all to authenticated
  using (public.is_active_staff())
  with check (public.is_active_staff());

grant select, insert, update, delete on public.journey_runs to service_role;

-- ─────────────────────────────────────────────────────────────────────
-- Seed Program 14-day. The cadence matches the spec's "first 14 days
-- of a Program track buyer" arc — welcome, two motivational nudges,
-- mid-point check, graduation + upsell to investor mentorship.
-- Templates referenced (c7, c11, c12, c13) are from migration 062.
-- ─────────────────────────────────────────────────────────────────────
insert into public.journey_definitions (code, name_he, description, trigger_event, trigger_conditions, steps)
values
  ('program_14d', 'מסע הצטרפות — הדרך לדירה',
   'מסע 14 ימים שמלווה רוכש חדש של תוכנית הדרך לדירה: הענקת גישה, חיזוקים, צ׳ק-אין, וסיום עם הצעת אפסייל.',
   'deal.won_program',
   jsonb_build_object(
     'all', jsonb_build_array(
       jsonb_build_object('field', 'deal.track', 'op', 'eq', 'value', 'program')
     )
   ),
   jsonb_build_array(
     jsonb_build_object(
       'name', 'day_0_welcome',
       'delay_hours', 0,
       'actions', jsonb_build_array(
         jsonb_build_object('type', 'send_template', 'key', 'c7', 'channel', 'whatsapp')
       )
     ),
     jsonb_build_object(
       'name', 'day_3_motivation',
       'delay_hours', 72,
       'conditions', jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false),
       'actions', jsonb_build_array(
         jsonb_build_object('type', 'send_template', 'key', 'c11', 'channel', 'whatsapp')
       )
     ),
     jsonb_build_object(
       'name', 'day_7_check_in',
       'delay_hours', 96,
       'conditions', jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false),
       'actions', jsonb_build_array(
         jsonb_build_object('type', 'create_task',
                            'title', 'צ׳ק-אין יום 7 — תכנית הדרך לדירה',
                            'kind', 'check_in', 'due_in_hours', 24)
       )
     ),
     jsonb_build_object(
       'name', 'day_14_graduation',
       'delay_hours', 168,
       'conditions', jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false),
       'actions', jsonb_build_array(
         jsonb_build_object('type', 'send_template', 'key', 'c12', 'channel', 'whatsapp'),
         jsonb_build_object('type', 'send_template', 'key', 'c13', 'channel', 'whatsapp')
       )
     )
   )
  )
on conflict (code) do update set
  name_he = excluded.name_he,
  description = excluded.description,
  trigger_event = excluded.trigger_event,
  trigger_conditions = excluded.trigger_conditions,
  steps = excluded.steps;

-- Register the journey-tick rule in the catalog for visibility on
-- /automations. Marked as 'engine' source even though it's a
-- standalone advancer (not a rule); makes the catalog complete.
insert into public.automation_rules (code, name_he, description, trigger_event, category, source, enabled, implementation_ref)
values
  ('journey_tick_advance', 'מתקדם מסעות בזמן',
   'סורק כל 10 דקות journey_runs פעילים ש-scheduled_next_at שלהם הגיע, מריץ את השלב הבא',
   'cron.tick', 'control', 'engine', true, 'automation-tick + journey-runner')
on conflict (code) do update set
  name_he = excluded.name_he,
  description = excluded.description,
  source = excluded.source,
  implementation_ref = excluded.implementation_ref;

comment on table public.journey_definitions is
  'Tier 4.B — journey recipe. Steps array is the editable cadence + copy.';
comment on table public.journey_runs is
  'Tier 4.B — per-contact journey instance. scheduled_next_at indexed for cron scan.';
