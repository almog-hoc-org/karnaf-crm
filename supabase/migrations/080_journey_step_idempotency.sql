-- 080_journey_step_idempotency.sql
--
-- Tier 7.B.2 — protect against duplicate sends in burst.
--
-- The cron tick currently runs every 10 minutes. If pg_cron double-
-- fires (rare but documented behaviour under certain restart paths)
-- or if an admin manually invokes the tick while a previous run is
-- still in-flight, the same journey_run can be picked up twice within
-- seconds. Each pickup re-executes the CURRENT step from scratch:
-- the same send_template fires, queueing a duplicate outbound_dispatch
-- row → the customer gets the same WhatsApp message twice.
--
-- This migration adds two columns to journey_runs:
--   * last_step_executed_at — when we last ran the current step's
--     actions. Updated in the runner before dispatch.
--   * last_step_idx — the step index that was executed. Used so a
--     step advance + same-step pickup are distinguishable.
--
-- The runner gates: if `last_step_idx == current_step` and
-- `last_step_executed_at` is within 60 seconds, skip the dispatch.
-- 60s is a generous window — a normal tick advances `current_step`
-- after dispatch, so the gate only fires on accidental double-pickup.

alter table public.journey_runs
  add column if not exists last_step_executed_at timestamptz,
  add column if not exists last_step_idx int;

comment on column public.journey_runs.last_step_executed_at is
  'Tier 7.B.2 — wall-clock of last step execution. Runner gates on this + last_step_idx to suppress duplicate sends within 60s.';
