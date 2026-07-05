// startJourney — extracted from the Tier 4.B journey-runner when the
// branches merged. The engine action `journey_start` (automation-engine.ts)
// creates journey_runs rows here; the cron-side advance loop lives in
// journey-runner.ts (prod version, advanceDueJourneys).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { evaluateConditions } from './automation-engine.ts';
import { log } from './logger.ts';

interface JourneyStep {
  name?: string;
  delay_hours?: number;
  conditions?: Record<string, unknown>;
  actions?: Array<Record<string, unknown>>;
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
