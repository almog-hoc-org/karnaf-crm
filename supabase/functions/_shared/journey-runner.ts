// Customer-journey runner. Tier 4.B.
//
// Two responsibilities:
//   1. startJourney — invoked by engine action `journey_start`.
//      Reads the named definition, enforces allow_concurrent, creates
//      the journey_runs row, and schedules step 0.
//   2. advanceDueRuns — invoked by the cron tick. Picks every
//      journey_runs with scheduled_next_at <= now() and status='active',
//      executes the current step's actions through the engine,
//      computes the next step's scheduled_next_at, persists.
//
// Step execution uses dispatchAction directly (not runMatchingRules)
// because a journey step IS the action list — no conditions evaluation
// at the rule layer, just the optional per-step `conditions` field
// which we evaluate inline.
//
// Failure policy: a step whose actions all return failed marks the run
// 'failed' with last_error so /journeys surfaces it. A step whose
// conditions don't match is logged as "skipped" but the run advances
// — skipping steps is normal (e.g. do_not_contact flips on mid-flight).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { dispatchAction, evaluateConditions } from './automation-engine.ts';
import { logAutomationRun } from './automation-log.ts';
import { log } from './logger.ts';

interface RetryPolicy {
  // Maximum retries before the run is marked failed. Default 0 (no
  // retries; keeps existing journeys behaving exactly as before).
  max_retries?: number;
  // Minutes to wait before the next retry attempt. Default 60.
  retry_delay_minutes?: number;
}

interface JourneyStep {
  name?: string;
  delay_hours?: number;
  conditions?: Record<string, unknown>;
  actions?: Array<Record<string, unknown>>;
  // Tier 4.D.4 — per-step retry config. When set, an all-failed step
  // bumps a retry counter in journey_runs.state and reschedules
  // instead of failing the run. Without this field, behaviour is
  // identical to pre-4.D.4 (one failed pass halts).
  retry_policy?: RetryPolicy;
}

interface JourneyDefinition {
  id: string;
  code: string;
  name_he: string;
  trigger_conditions: Record<string, unknown>;
  steps: JourneyStep[];
  enabled: boolean;
  allow_concurrent: boolean;
}

// ── Start ─────────────────────────────────────────────────────────────

export interface StartJourneyInput {
  code: string;
  contactId: string;
  context?: Record<string, unknown>;
  correlationId?: string;
}

export interface StartJourneyResult {
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
  run_id?: string;
}

export async function startJourney(
  supabase: SupabaseClient,
  input: StartJourneyInput,
): Promise<StartJourneyResult> {
  const { data: defs, error: defErr } = await supabase
    .from('journey_definitions')
    .select('*')
    .eq('code', input.code)
    .maybeSingle();
  if (defErr) return { status: 'failed', reason: defErr.message };
  if (!defs) return { status: 'skipped', reason: `journey ${input.code} not found` };
  if (!defs.enabled) return { status: 'skipped', reason: 'journey disabled' };

  const def = defs as JourneyDefinition;
  const steps: JourneyStep[] = Array.isArray(def.steps) ? def.steps : [];
  if (steps.length === 0) return { status: 'skipped', reason: 'no steps defined' };

  // Trigger conditions gate the start.
  if (input.context && !evaluateConditions(def.trigger_conditions ?? {}, input.context)) {
    return { status: 'skipped', reason: 'trigger conditions did not match' };
  }

  // Dedupe — one active run per (definition, contact) unless
  // allow_concurrent is set.
  if (!def.allow_concurrent) {
    const { data: existing } = await supabase
      .from('journey_runs')
      .select('id')
      .eq('definition_id', def.id)
      .eq('contact_id', input.contactId)
      .eq('status', 'active')
      .maybeSingle();
    if (existing) return { status: 'skipped', reason: 'already active for this contact', run_id: existing.id };
  }

  const firstStep = steps[0];
  const delayMs = (firstStep.delay_hours ?? 0) * 3600 * 1000;
  const scheduledNext = new Date(Date.now() + delayMs).toISOString();

  const { data: created, error: insErr } = await supabase
    .from('journey_runs')
    .insert({
      definition_id: def.id,
      definition_code: def.code,
      contact_id: input.contactId,
      current_step: 0,
      state: { started_via: input.correlationId ?? null },
      scheduled_next_at: scheduledNext,
      status: 'active',
    })
    .select('id')
    .single();
  // Tier 7.A.3 — partial unique index on (definition_id, contact_id)
  // where status='active' (migration 077) atomically protects against
  // burst races. When a concurrent insert beat us to it, the error
  // code is 23505. Treat the same as the check-then-insert dedup
  // above: skip and return success-ish so callers don't retry.
  if (insErr) {
    const errCode = (insErr as { code?: string }).code;
    if (errCode === '23505') {
      return { status: 'skipped', reason: 'concurrent start lost the race — already active' };
    }
    return { status: 'failed', reason: insErr.message };
  }

  log.info('journey_started', { code: def.code, contactId: input.contactId, runId: created?.id });
  return { status: 'ok', run_id: created?.id };
}

// ── Tick ──────────────────────────────────────────────────────────────

interface DueRun {
  id: string;
  definition_id: string;
  definition_code: string;
  contact_id: string;
  current_step: number;
  state: Record<string, unknown>;
  // Tier 7.B.2 — idempotency guard. Runner skips a step if it was
  // already executed within the last 60 seconds for the same step idx.
  last_step_executed_at: string | null;
  last_step_idx: number | null;
  // The runner re-joins the steps live from journey_definitions on
  // each tick so an edit to a definition propagates immediately.
}

export interface AdvanceTickResult {
  processed: number;
  completed: number;
  failed: number;
  // Tier 7.A.5 — surfaces the query error so the tick orchestrator
  // can fail the response (pg_cron retries on 5xx).
  query_error: string | null;
  // Tier 7.B.6 — when MAX_RUNS_PER_TICK was hit, signals that more
  // due runs exist; the tick log uses this to emit a cap-breach warning.
  cap_reached: boolean;
}

const MAX_RUNS_PER_TICK = 200;

export async function advanceDueRuns(
  supabase: SupabaseClient,
  correlationId?: string,
): Promise<AdvanceTickResult> {
  const summary: AdvanceTickResult = {
    processed: 0, completed: 0, failed: 0, query_error: null, cap_reached: false,
  };

  const { data: runs, error } = await supabase
    .from('journey_runs')
    .select('id, definition_id, definition_code, contact_id, current_step, state, last_step_executed_at, last_step_idx')
    .eq('status', 'active')
    .lte('scheduled_next_at', new Date().toISOString())
    .order('scheduled_next_at', { ascending: true })
    .limit(MAX_RUNS_PER_TICK);
  if (error) {
    log.error('journey_tick_query_failed', { err: error.message });
    summary.query_error = error.message;
    return summary;
  }
  if ((runs?.length ?? 0) >= MAX_RUNS_PER_TICK) summary.cap_reached = true;

  for (const run of runs ?? []) {
    const result = await advanceOneRun(supabase, run as DueRun, correlationId);
    summary.processed++;
    if (result === 'completed') summary.completed++;
    if (result === 'failed') summary.failed++;
  }

  return summary;
}

async function advanceOneRun(
  supabase: SupabaseClient,
  run: DueRun,
  correlationId?: string,
): Promise<'advanced' | 'completed' | 'failed' | 'skipped'> {
  // Load definition fresh — edits propagate immediately to in-flight runs.
  const { data: def, error: defErr } = await supabase
    .from('journey_definitions')
    .select('id, code, steps, enabled')
    .eq('id', run.definition_id)
    .maybeSingle();
  if (defErr || !def) {
    await failRun(supabase, run.id, defErr?.message ?? 'definition gone');
    return 'failed';
  }
  if (!def.enabled) {
    // Disabled mid-flight → cancel the run so the queue clears.
    await supabase.from('journey_runs').update({
      status: 'cancelled', cancelled_at: new Date().toISOString(),
      cancellation_reason: 'definition disabled',
    }).eq('id', run.id);
    return 'skipped';
  }

  const steps: JourneyStep[] = Array.isArray(def.steps) ? (def.steps as JourneyStep[]) : [];
  const step = steps[run.current_step];
  if (!step) {
    // Walked past the last step → complete.
    await supabase.from('journey_runs').update({
      status: 'completed', completed_at: new Date().toISOString(),
    }).eq('id', run.id);
    log.info('journey_completed', {
      run_id: run.id, definition_code: def.code, contact_id: run.contact_id, correlation_id: correlationId,
    });
    return 'completed';
  }

  // Tier 7.B.2 — idempotency guard. If the same step was just
  // executed within 60 seconds (e.g. cron double-fire, manual replay),
  // skip dispatch and let the next tick continue from current_step.
  if (run.last_step_idx === run.current_step && run.last_step_executed_at) {
    const ageMs = Date.now() - Date.parse(run.last_step_executed_at);
    if (ageMs < 60_000) {
      log.warn('journey_step_recent_duplicate_skipped', {
        run_id: run.id, definition_code: def.code, step_idx: run.current_step,
        step_name: step.name ?? null, age_ms: ageMs, correlation_id: correlationId,
      });
      return 'skipped';
    }
  }

  // Tier 7.B.1 — canonical context shape via shared builder. Replaces
  // the journey-runner's inline 9-field copy so all engine paths
  // converge on the same lead.* shape. journey block stays unchanged.
  const { buildLeadContext } = await import('./event-context.ts');
  const leadCtx = await buildLeadContext(supabase, run.contact_id);
  const context = {
    lead: leadCtx,
    journey: { code: def.code, step_index: run.current_step, step_name: step.name ?? null },
  };

  // Per-step conditions gate execution. Failing conditions = skip
  // *this step* but advance to the next; that's the desired UX.
  const conditionsOk = evaluateConditions(step.conditions ?? {}, context);
  const actionResults: Array<Record<string, unknown>> = [];

  if (conditionsOk) {
    for (const action of step.actions ?? []) {
      const r = await dispatchAction(action, {
        supabase, context, contactId: run.contact_id, correlationId,
      });
      actionResults.push(r as unknown as Record<string, unknown>);
    }
  }

  // Decide outcome.
  const nextStepIdx = run.current_step + 1;
  const isLast = nextStepIdx >= steps.length;
  const allFailed = actionResults.length > 0 && actionResults.every((r) => r.status === 'failed');
  const anySucceeded = actionResults.some((r) => r.status === 'ok');

  // A step that explicitly fails every action either retries (when
  // retry_policy is set and there are attempts left) or halts the run.
  if (allFailed && !anySucceeded) {
    const policy = step.retry_policy;
    const maxRetries = policy?.max_retries ?? 0;
    if (maxRetries > 0) {
      const state = (run.state as Record<string, unknown>) ?? {};
      const stepRetries = (state.step_retries as Record<string, number>) ?? {};
      const stepKey = String(run.current_step);
      const usedRetries = stepRetries[stepKey] ?? 0;
      if (usedRetries < maxRetries) {
        // Reschedule the *same* step for retry. current_step doesn't
        // advance; scheduled_next_at moves forward by retry_delay_minutes.
        const delayMs = (policy?.retry_delay_minutes ?? 60) * 60 * 1000;
        const nextAttempt = new Date(Date.now() + delayMs).toISOString();
        const nextState = {
          ...state,
          step_retries: { ...stepRetries, [stepKey]: usedRetries + 1 },
        };
        // Tier 7.B.2 — also stamp last_step_executed_at/last_step_idx
        // on retry path so the idempotency gate fires correctly on a
        // hypothetical double-tick during the retry delay window.
        await supabase.from('journey_runs').update({
          state: nextState,
          scheduled_next_at: nextAttempt,
          last_step_executed_at: new Date().toISOString(),
          last_step_idx: run.current_step,
        }).eq('id', run.id);
        await logAutomationRun(supabase, {
          ruleCode: `journey:${def.code}:step:${step.name ?? run.current_step}`,
          triggerEvent: 'journey.advance',
          contactId: run.contact_id,
          context,
          actionResults,
          status: 'partial',
          reason: `retry ${usedRetries + 1}/${maxRetries} scheduled in ${policy?.retry_delay_minutes ?? 60} min`,
          correlationId,
        });
        // Tier 7.B.4 — enriched journey log.
        log.warn('journey_step_retry_scheduled', {
          run_id: run.id, definition_code: def.code, contact_id: run.contact_id,
          step_idx: run.current_step, step_name: step.name ?? null,
          retry: usedRetries + 1, max_retries: maxRetries,
          correlation_id: correlationId,
        });
        return 'advanced';
      }
    }
    // No retry budget left (or no policy) → halt the run.
    await failRun(supabase, run.id, 'all step actions failed');
    await logAutomationRun(supabase, {
      ruleCode: `journey:${def.code}:step:${step.name ?? run.current_step}`,
      triggerEvent: 'journey.advance',
      contactId: run.contact_id,
      context,
      actionResults,
      status: 'failed',
      reason: 'all step actions failed' + (maxRetries > 0 ? ` (after ${maxRetries} retries)` : ''),
      correlationId,
    });
    log.error('journey_step_failed', {
      run_id: run.id, definition_code: def.code, contact_id: run.contact_id,
      step_idx: run.current_step, step_name: step.name ?? null,
      max_retries: maxRetries, correlation_id: correlationId,
    });
    return 'failed';
  }

  // Otherwise: log + advance pointer + schedule next.
  await logAutomationRun(supabase, {
    ruleCode: `journey:${def.code}:step:${step.name ?? run.current_step}`,
    triggerEvent: 'journey.advance',
    contactId: run.contact_id,
    context,
    actionResults,
    status: conditionsOk ? (actionResults.some((r) => r.status === 'failed') ? 'partial' : 'success') : 'skipped',
    reason: conditionsOk ? undefined : 'step conditions did not match — skipped',
    correlationId,
  });

  // Tier 7.B.2 — stamp idempotency fields on every successful step
  // dispatch. last_step_idx records which step we executed; the next
  // tick checks it before re-firing the same step.
  const executedAt = new Date().toISOString();
  if (isLast) {
    await supabase.from('journey_runs').update({
      status: 'completed', completed_at: executedAt,
      current_step: nextStepIdx,
      last_step_executed_at: executedAt,
      last_step_idx: run.current_step,
    }).eq('id', run.id);
    log.info('journey_completed', {
      run_id: run.id, definition_code: def.code, contact_id: run.contact_id,
      step_idx: run.current_step, step_name: step.name ?? null, correlation_id: correlationId,
    });
    return 'completed';
  }

  const nextStep = steps[nextStepIdx];
  const delayMs = (nextStep.delay_hours ?? 0) * 3600 * 1000;
  const nextScheduled = new Date(Date.now() + delayMs).toISOString();
  await supabase.from('journey_runs').update({
    current_step: nextStepIdx,
    scheduled_next_at: nextScheduled,
    last_step_executed_at: executedAt,
    last_step_idx: run.current_step,
  }).eq('id', run.id);
  log.info('journey_step_advanced', {
    run_id: run.id, definition_code: def.code, contact_id: run.contact_id,
    step_idx: run.current_step, step_name: step.name ?? null,
    next_step_idx: nextStepIdx, correlation_id: correlationId,
  });
  return 'advanced';
}

async function failRun(supabase: SupabaseClient, runId: string, reason: string): Promise<void> {
  await supabase.from('journey_runs').update({
    status: 'failed',
    last_error: reason,
  }).eq('id', runId);
}
