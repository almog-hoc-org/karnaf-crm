import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runActions, type EngineContext } from './automation-engine.ts';
import type { LeadRow } from './lead-service.ts';

interface JourneyRunRow {
  id: string;
  definition_id: string;
  definition_code: string;
  contact_id: string;
  current_step: number;
  state: Record<string, unknown>;
}

interface JourneyDefinitionRow {
  id: string;
  code: string;
  steps: Array<{
    name?: string;
    delay_hours?: number;
    actions?: Array<Record<string, unknown>>;
  }>;
}

export async function advanceDueJourneys(
  supabase: SupabaseClient,
  correlationId: string,
  limit = 50,
): Promise<{ advanced: number; completed: number; failed: number }> {
  const { data: runs, error } = await supabase
    .from('journey_runs')
    .select('id, definition_id, definition_code, contact_id, current_step, state')
    .eq('status', 'active')
    .lte('scheduled_next_at', new Date().toISOString())
    .order('scheduled_next_at', { ascending: true })
    .limit(limit);
  if (error) throw error;

  const counters = { advanced: 0, completed: 0, failed: 0 };
  for (const run of (runs ?? []) as JourneyRunRow[]) {
    const { data: definition, error: definitionErr } = await supabase
      .from('journey_definitions')
      .select('id, code, steps')
      .eq('id', run.definition_id)
      .single();
    if (definitionErr || !definition) {
      await supabase.from('journey_runs').update({
        status: 'failed',
        last_error: definitionErr?.message ?? 'definition_missing',
      }).eq('id', run.id);
      counters.failed++;
      continue;
    }

    const def = definition as JourneyDefinitionRow;
    const step = def.steps[run.current_step];
    if (!step) {
      await supabase.from('journey_runs').update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      }).eq('id', run.id);
      counters.completed++;
      continue;
    }

    const { data: lead, error: leadErr } = await supabase
      .from('leads')
      .select('*')
      .eq('id', run.contact_id)
      .single();
    if (leadErr || !lead) {
      await supabase.from('journey_runs').update({
        status: 'failed',
        last_error: leadErr?.message ?? 'lead_missing',
      }).eq('id', run.id);
      counters.failed++;
      continue;
    }

    const ctx: EngineContext = {
      lead: lead as LeadRow,
      triggerEvent: `journey.${def.code}.${step.name ?? run.current_step}`,
      correlationId,
      data: { journey_run_id: run.id, journey_code: def.code, step_name: step.name ?? null },
    };
    const results = await runActions(supabase, (step.actions ?? []) as Array<Record<string, unknown>>, ctx);
    const failed = results.some((r) => r.status === 'failed');
    if (failed) {
      await supabase.from('journey_runs').update({
        status: 'failed',
        last_error: JSON.stringify(results),
        metadata: { last_results: results, correlation_id: correlationId },
      }).eq('id', run.id);
      counters.failed++;
      continue;
    }

    const nextStep = run.current_step + 1;
    const next = def.steps[nextStep];
    if (!next) {
      await supabase.from('journey_runs').update({
        current_step: nextStep,
        status: 'completed',
        completed_at: new Date().toISOString(),
        metadata: { last_results: results, correlation_id: correlationId },
      }).eq('id', run.id);
      counters.completed++;
    } else {
      const delayHours = Number(next.delay_hours ?? 0);
      await supabase.from('journey_runs').update({
        current_step: nextStep,
        scheduled_next_at: new Date(Date.now() + delayHours * 3600 * 1000).toISOString(),
        metadata: { last_results: results, correlation_id: correlationId },
      }).eq('id', run.id);
      counters.advanced++;
    }
  }

  return counters;
}
