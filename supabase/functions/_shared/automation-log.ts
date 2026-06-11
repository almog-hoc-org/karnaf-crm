// Tiny helper for code-driven automations to log their fires into
// automation_runs. Drop-in: anywhere the code already "did the thing
// the rule says", call logAutomationRun and the audit trail picks it
// up. The run log feeds the /automations admin UI's "recent runs"
// pane and the failure index drives oncall alerting.
//
// Inserts via service_role; never throws — logging failures must not
// take down the actual automation.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { log } from './logger.ts';

export interface AutomationRunInput {
  // Stable string matching automation_rules.code. Use the same value
  // every time so the admin UI's per-rule history works.
  ruleCode: string;
  // What event you reacted to. Matches automation_rules.trigger_event.
  triggerEvent: string;
  // Contact this run was about, when applicable.
  contactId?: string | null;
  // Snapshot of the data you saw — keep it small. Just enough to
  // debug "why did this skip?".
  context?: Record<string, unknown>;
  // Empty when status === 'skipped' or 'failed'. One entry per action
  // the rule performed (send_template, create_task, etc.).
  actionResults?: Array<Record<string, unknown>>;
  status?: 'success' | 'skipped' | 'failed' | 'partial';
  // When status !== 'success', a one-line explanation.
  reason?: string;
  durationMs?: number;
  correlationId?: string;
}

// Tier 7.D.1 — context blob cap. Every run today logs the full lead
// context (~600 bytes) plus deal/project blocks. At 1k rules/day that
// becomes meaningful storage growth over months. 4096 bytes is enough
// to debug a typical "why did this skip" question; anything bigger gets
// truncated and a marker added so the operator knows.
const CONTEXT_MAX_BYTES = 4096;

function truncateContext(ctx: Record<string, unknown> | undefined):
  { context: Record<string, unknown>; truncated: boolean }
{
  if (!ctx) return { context: {}, truncated: false };
  const json = JSON.stringify(ctx);
  if (json.length <= CONTEXT_MAX_BYTES) return { context: ctx, truncated: false };
  // Keep top-level keys but trim long string values. Faster than
  // recursive walk and matches the typical context shape (lead, deal,
  // partner, project — none of those have deep nesting).
  const trimmed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (typeof v === 'string' && v.length > 200) {
      trimmed[k] = v.slice(0, 200) + '…(truncated)';
    } else {
      trimmed[k] = v;
    }
  }
  return { context: trimmed, truncated: true };
}

export async function logAutomationRun(
  supabase: SupabaseClient,
  input: AutomationRunInput,
): Promise<void> {
  try {
    const { context: trimmedContext, truncated } = truncateContext(input.context);
    const { error } = await supabase.from('automation_runs').insert({
      rule_code: input.ruleCode,
      trigger_event: input.triggerEvent,
      contact_id: input.contactId ?? null,
      context: { ...trimmedContext, ...(truncated ? { _truncated: true } : {}) },
      action_results: input.actionResults ?? [],
      status: input.status ?? 'success',
      reason: input.reason ?? null,
      duration_ms: input.durationMs ?? null,
      correlation_id: input.correlationId ?? null,
    });
    if (error) {
      log.warn('automation_run_log_failed', {
        fn: 'logAutomationRun', ruleCode: input.ruleCode, err: error.message,
      });
    }
  } catch (err) {
    // Never let logging crash the caller. Telemetry is nice-to-have;
    // the automation itself is the real work.
    log.warn('automation_run_log_threw', {
      fn: 'logAutomationRun', ruleCode: input.ruleCode,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
