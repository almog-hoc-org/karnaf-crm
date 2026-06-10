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

export async function logAutomationRun(
  supabase: SupabaseClient,
  input: AutomationRunInput,
): Promise<void> {
  try {
    const { error } = await supabase.from('automation_runs').insert({
      rule_code: input.ruleCode,
      trigger_event: input.triggerEvent,
      contact_id: input.contactId ?? null,
      context: input.context ?? {},
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
