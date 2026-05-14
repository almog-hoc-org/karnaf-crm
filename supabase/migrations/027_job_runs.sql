-- Karnaf CRM Core - Idempotency ledger for cron-driven jobs.
--
-- nightly-jobs runs 4 RPCs in parallel (apply_lead_score_decay,
-- purge_removed_pii, compact_integration_logs, autoReweightPromptVariants).
-- Without a "last_run" marker the function could fire twice on the same
-- date (Supabase clock skew, manual re-trigger, overlapping cron), causing
-- e.g. lead-score decay to deduct twice in 24h.
--
-- This migration adds a `job_runs` table keyed by (run_date, kind). The
-- nightly-jobs function inserts on-conflict-do-nothing per kind before
-- invoking the underlying RPC; if the insert is a no-op, the kind is
-- skipped this run.

create table if not exists job_runs (
  run_date  date         not null,
  kind      text         not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status    text         not null default 'started' check (status in ('started','completed','failed','skipped')),
  error_message text,
  primary key (run_date, kind)
);

create index if not exists ix_job_runs_started_at on job_runs (started_at desc);

-- Helper: caller asks "may I run job <kind> today?". Returns true if no
-- row exists for today (and inserts one as 'started'), false if already
-- claimed by an earlier invocation. Race-safe via on-conflict.
create or replace function claim_job_run(p_kind text)
returns boolean
language plpgsql
as $$
declare
  v_inserted boolean := false;
begin
  insert into job_runs (run_date, kind, status)
  values (current_date, p_kind, 'started')
  on conflict (run_date, kind) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted > 0;
end;
$$;

create or replace function finalize_job_run(p_kind text, p_status text, p_error text default null)
returns void
language plpgsql
as $$
begin
  update job_runs
     set completed_at  = now(),
         status        = coalesce(p_status, status),
         error_message = coalesce(p_error, error_message)
   where run_date = current_date and kind = p_kind;
end;
$$;
