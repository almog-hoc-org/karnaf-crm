-- 077_journey_runs_unique_active.sql
--
-- Tier 7.A.3 — close the race in startJourney by enforcing uniqueness
-- at the database level.
--
-- Today journey-runner.ts:96-105 does a check-then-insert under the
-- assumption that allow_concurrent=false journeys can have at most
-- one active run per contact. Under a burst (two deal.won events
-- within ~100ms — possible if a webhook + admin click coincide), both
-- checks pass before either insert lands, so two active rows get
-- created. The runner happily advances both, and the customer sees
-- duplicate messages.
--
-- Fix: a partial unique index on (definition_id, contact_id) restricted
-- to active rows. The runner now catches the unique-violation (Postgres
-- error code 23505) and treats it the same as the existing dedup path
-- ("already active for this contact"). Atomic, no race.
--
-- Pre-flight: any DB rows that today violate the new constraint would
-- block index creation. Cancel duplicates first by keeping only the
-- oldest active run per (definition, contact) and marking the rest
-- 'cancelled' with a clear reason. The trade-off: we lose any progress
-- the newer rows had. That's acceptable — they're duplicates from a
-- race that should never have created them in the first place.

do $$
declare
  cancelled_count integer;
begin
  with ranked as (
    select id,
           row_number() over (
             partition by definition_id, contact_id
             order by started_at asc
           ) as rn
      from public.journey_runs
     where status = 'active'
  ),
  losers as (
    update public.journey_runs jr
       set status = 'cancelled',
           cancelled_at = now(),
           cancellation_reason = 'tier 7.A.3 dedup — pre-existing duplicate active run'
      from ranked
     where ranked.id = jr.id
       and ranked.rn > 1
     returning jr.id
  )
  select count(*) into cancelled_count from losers;

  if cancelled_count > 0 then
    raise notice 'Tier 7.A.3: cancelled % duplicate active journey_runs before creating unique index', cancelled_count;
  end if;
end $$;

-- The actual index. Partial so completed/cancelled/failed rows don't
-- block legitimate re-runs (e.g. cancelled-and-restarted journey).
create unique index if not exists uniq_journey_runs_active_per_contact
  on public.journey_runs (definition_id, contact_id)
  where status = 'active';
