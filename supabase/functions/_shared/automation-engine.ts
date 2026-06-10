// The runtime that consumes automation_rules and dispatches their
// actions. Tier 4.A foundation.
//
// Design:
// * Pure-function condition evaluator (testable in isolation).
// * Action dispatcher with one switch per type — adding an action
//   type is one case, no metaprogramming.
// * Every fire (success / skip / fail) writes to automation_runs via
//   the Tier 2 helper, so the /automations page surfaces engine
//   activity the same way it surfaces code-driven activity.
// * Never throws — the caller (cron tick / event source) treats this
//   like fire-and-forget telemetry. One bad rule must not break the
//   whole tick.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { logAutomationRun } from './automation-log.ts';
import { notifyTelegram } from './notify-telegram.ts';
import { log } from './logger.ts';

// ── Conditions DSL ────────────────────────────────────────────────────

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { field: string; op: ConditionOp; value?: unknown };

export type ConditionOp =
  | 'eq' | 'neq' | 'in' | 'not_in'
  | 'gte' | 'lte' | 'gt' | 'lt'
  | 'exists' | 'not_exists';

// Resolves a dotted path against a nested context object. Returns
// undefined when any step is missing — leaves the leaf op to decide
// whether undefined matches.
export function resolvePath(context: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = context;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function evaluateConditions(conditions: unknown, context: Record<string, unknown>): boolean {
  // Empty conditions = always-match. Useful for "fire on every tick"
  // rules where the cron schedule is the only gate.
  if (!conditions || typeof conditions !== 'object') return true;
  const c = conditions as Record<string, unknown>;
  if (Object.keys(c).length === 0) return true;

  if (Array.isArray(c.all)) {
    return (c.all as Condition[]).every((sub) => evaluateConditions(sub, context));
  }
  if (Array.isArray(c.any)) {
    return (c.any as Condition[]).some((sub) => evaluateConditions(sub, context));
  }

  // Leaf condition.
  const field = c.field as string | undefined;
  const op = c.op as ConditionOp | undefined;
  if (!field || !op) return false;
  const actual = resolvePath(context, field);
  const expected = c.value;

  switch (op) {
    case 'eq': return actual === expected;
    case 'neq': return actual !== expected;
    case 'in': return Array.isArray(expected) && (expected as unknown[]).includes(actual);
    case 'not_in': return Array.isArray(expected) && !(expected as unknown[]).includes(actual);
    case 'gte': return Number(actual) >= Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
    case 'gt': return Number(actual) > Number(expected);
    case 'lt': return Number(actual) < Number(expected);
    case 'exists': return actual !== undefined && actual !== null;
    case 'not_exists': return actual === undefined || actual === null;
    default: return false;
  }
}

// ── Action dispatcher ─────────────────────────────────────────────────

export interface ActionContext {
  supabase: SupabaseClient;
  // The same context blob conditions evaluated against. Actions read
  // from it too (e.g. send_template needs lead.full_name for var
  // substitution).
  context: Record<string, unknown>;
  contactId?: string | null;
  correlationId?: string;
}

interface ActionResult {
  type: string;
  status: 'ok' | 'skipped' | 'failed';
  detail?: Record<string, unknown> | string;
}

// Exported so journey-runner.ts can reuse the same action dispatcher
// for per-step actions. Keeps a single switch-per-type, one truth.
export async function dispatchAction(action: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const type = action.type as string | undefined;
  if (!type) return { type: 'unknown', status: 'skipped', detail: 'missing type' };

  try {
    switch (type) {
      case 'send_template': return await actionSendTemplate(action, ctx);
      case 'notify_internal': return await actionNotifyInternal(action, ctx);
      case 'create_task': return await actionCreateTask(action, ctx);
      case 'set_field': return await actionSetField(action, ctx);
      case 'journey_start': return await actionJourneyStart(action, ctx);
      case 'assign_partner': return await actionAssignPartner(action, ctx);
      default:
        return { type, status: 'skipped', detail: `unknown action type: ${type}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('action_dispatch_failed', { type, err: msg });
    return { type, status: 'failed', detail: msg };
  }
}

// Shared variable substitution — same {{var}} markers the frontend's
// template-render.ts uses, kept in sync by convention.
function renderBody(body: string, context: Record<string, unknown>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, name: string) => {
    const v = resolvePath(context, name) ?? resolvePath(context, `lead.${name}`);
    if (v === undefined || v === null || v === '') {
      if (!missing.includes(name)) missing.push(name);
      return `{{${name}}}`;
    }
    return String(v);
  });
  return { text, missing };
}

async function actionSendTemplate(action: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const key = action.key as string | undefined;
  const channel = (action.channel as string | undefined) ?? 'whatsapp';
  if (!key) return { type: 'send_template', status: 'skipped', detail: 'missing key' };
  if (!ctx.contactId) return { type: 'send_template', status: 'skipped', detail: 'no contactId' };

  const { data: tpl, error } = await ctx.supabase
    .from('message_templates')
    .select('id, body, status, key')
    .eq('key', key).eq('channel', channel).maybeSingle();
  if (error) return { type: 'send_template', status: 'failed', detail: error.message };
  if (!tpl) return { type: 'send_template', status: 'skipped', detail: `template ${channel}:${key} not found` };
  if (tpl.status !== 'active') return { type: 'send_template', status: 'skipped', detail: `template ${key} is ${tpl.status}` };

  const { text, missing } = renderBody(tpl.body, ctx.context);
  if (missing.length > 0) {
    // Engine refuses half-filled templates. Better to log + skip than
    // send "{{first_name}}" to a customer.
    return { type: 'send_template', status: 'skipped', detail: `missing vars: ${missing.join(', ')}` };
  }

  // Enqueue via outbound_dispatch the same way manual replies do.
  // outbound_dispatch holds the channel + text inside payload jsonb
  // and uses lead_id as the FK — matches existing 036 schema.
  const { data: enq, error: enqErr } = await ctx.supabase.from('outbound_dispatch').insert({
    lead_id: ctx.contactId,
    payload: {
      kind: 'template',
      channel,
      text,
      template_key: key,
      source: 'automation_engine',
    },
    correlation_id: ctx.correlationId ?? null,
  }).select('id').maybeSingle();
  if (enqErr) return { type: 'send_template', status: 'failed', detail: enqErr.message };

  return {
    type: 'send_template', status: 'ok',
    detail: { dispatch_id: enq?.id, template_key: key, channel, chars: text.length },
  };
}

async function actionNotifyInternal(action: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const text = action.text as string | undefined;
  if (!text) return { type: 'notify_internal', status: 'skipped', detail: 'missing text' };

  // Render variables so internal notifications can reference lead
  // fields the same way customer-facing templates do.
  const { text: rendered } = renderBody(text, ctx.context);

  // Two channels in parallel:
  //   1. lead_events row (audit log; always written when contactId present).
  //   2. Telegram message (operator-visible) when env is configured.
  // Telegram failure does not fail the action — audit row is the
  // source of truth. Logs the Telegram outcome for ops debugging.
  let auditWritten = false;
  if (ctx.contactId) {
    const { error } = await ctx.supabase.from('lead_events').insert({
      lead_id: ctx.contactId,
      event_type: 'engine_internal_note',
      actor_type: 'system',
      event_payload: {
        text: rendered,
        source: 'automation_engine',
        correlation_id: ctx.correlationId ?? null,
      },
    });
    if (error) return { type: 'notify_internal', status: 'failed', detail: error.message };
    auditWritten = true;
  }

  // Tier 4.D.3 — forward to Telegram if configured. The notifier
  // silently no-ops when env vars are missing (NotifyResult.sent=false,
  // skipped='no_token' / 'no_chat'), so this is safe-by-default.
  const tg = await notifyTelegram({
    source: 'automation_engine',
    severity: 'info',
    title: rendered,
    correlationId: ctx.correlationId,
  });

  return {
    type: 'notify_internal',
    status: auditWritten || tg.sent ? 'ok' : 'skipped',
    detail: {
      chars: rendered.length,
      audit_written: auditWritten,
      telegram_sent: tg.sent,
      telegram_skipped: tg.skipped ?? null,
    },
  };
}

async function actionCreateTask(action: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const title = action.title as string | undefined;
  if (!title) return { type: 'create_task', status: 'skipped', detail: 'missing title' };
  if (!ctx.contactId) return { type: 'create_task', status: 'skipped', detail: 'no contactId' };

  const dueInHours = (action.due_in_hours as number | undefined) ?? 24;
  const due = new Date(Date.now() + dueInHours * 3600 * 1000).toISOString();

  const { data, error } = await ctx.supabase.from('lead_tasks').insert({
    lead_id: ctx.contactId,
    task_type: (action.kind as string | undefined) ?? 'follow_up',
    owner_type: 'system',
    title,
    due_at: due,
    payload_json: { source: 'automation_engine', correlation_id: ctx.correlationId ?? null },
  }).select('id').maybeSingle();
  if (error) return { type: 'create_task', status: 'failed', detail: error.message };

  return { type: 'create_task', status: 'ok', detail: { task_id: data?.id, due_at: due } };
}

// Tier 4.D.5 — partner round-robin assignment (B3).
// Picks the active partner with the lowest open_deals_count from
// partner_workload, updates the deal's partner_id. Self-healing:
// idempotent on repeat (returns 'skipped' if a partner is already
// assigned). The picked partner's info goes into action_results so
// downstream actions (send_template C5/C6, notify_internal) can
// reference the assignment.
//
// Context required:
//   deal.id   — which deal to assign on
//   deal.track (optional) — currently always investor_mentorship
//                          per spec § ז B3; future tracks can opt in
//                          via the action's `domain` argument.
async function actionAssignPartner(action: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const dealCtx = (ctx.context.deal as Record<string, unknown> | undefined) ?? null;
  const dealId = dealCtx?.id as string | undefined;
  if (!dealId) return { type: 'assign_partner', status: 'skipped', detail: 'no deal.id in context' };

  // Refresh the deal to avoid racing on partner_id — another tick
  // may already have assigned it.
  const { data: deal, error: dealErr } = await ctx.supabase
    .from('deals')
    .select('id, partner_id, track')
    .eq('id', dealId)
    .maybeSingle();
  if (dealErr) return { type: 'assign_partner', status: 'failed', detail: dealErr.message };
  if (!deal) return { type: 'assign_partner', status: 'skipped', detail: 'deal not found' };
  if (deal.partner_id) {
    return { type: 'assign_partner', status: 'skipped', detail: `already assigned to ${deal.partner_id}` };
  }

  const domain = (action.domain as string | undefined) ?? 'investor_mentorship';
  const { data: pick, error: pickErr } = await ctx.supabase
    .from('partner_workload')
    .select('partner_id, full_name, domain, commission_to_karnaf_pct, open_deals_count')
    .eq('status', 'active')
    .eq('domain', domain)
    .order('open_deals_count', { ascending: true })
    .order('full_name', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (pickErr) return { type: 'assign_partner', status: 'failed', detail: pickErr.message };
  if (!pick) return { type: 'assign_partner', status: 'skipped', detail: `no active partners in domain ${domain}` };

  const { error: updErr } = await ctx.supabase
    .from('deals')
    .update({ partner_id: pick.partner_id })
    .eq('id', dealId);
  if (updErr) return { type: 'assign_partner', status: 'failed', detail: updErr.message };

  // Mutate the live context so downstream actions in the SAME rule
  // can reference partner_name / partner_id without a re-fetch.
  // This is a per-run mutation; doesn't leak across rules.
  ctx.context.partner = {
    id: pick.partner_id,
    full_name: pick.full_name,
    domain: pick.domain,
  };
  // Also surface partner_name at top level for {{partner_name}}
  // template variable substitution.
  ctx.context.partner_name = pick.full_name;

  return {
    type: 'assign_partner',
    status: 'ok',
    detail: {
      deal_id: dealId,
      partner_id: pick.partner_id,
      partner_name: pick.full_name,
      open_deals_at_pick: pick.open_deals_count,
    },
  };
}

// journey_start delegates to the journey-runner — kept here as a thin
// wrapper so engine remains the single dispatch entry point and the
// runner stays the single owner of journey state.
async function actionJourneyStart(action: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const code = action.code as string | undefined;
  if (!code) return { type: 'journey_start', status: 'skipped', detail: 'missing code' };
  if (!ctx.contactId) return { type: 'journey_start', status: 'skipped', detail: 'no contactId' };

  // Late-import to avoid the runner ↔ engine cycle at module load.
  const { startJourney } = await import('./journey-runner.ts');
  const r = await startJourney(ctx.supabase, {
    code, contactId: ctx.contactId, context: ctx.context, correlationId: ctx.correlationId,
  });
  return { type: 'journey_start', status: r.status, detail: { code, run_id: r.run_id, reason: r.reason } };
}

async function actionSetField(action: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const table = action.table as string | undefined;
  const field = action.field as string | undefined;
  if (!table || !field) return { type: 'set_field', status: 'skipped', detail: 'missing table/field' };
  if (!ctx.contactId) return { type: 'set_field', status: 'skipped', detail: 'no contactId' };

  // Guardrail: engine can only write to a small whitelist of safe
  // columns. Opening this up to arbitrary columns is a foot-gun.
  const allowed: Record<string, string[]> = {
    leads: ['heat', 'next_action_type', 'next_action_due_at', 'tags'],
  };
  if (!allowed[table]?.includes(field)) {
    return { type: 'set_field', status: 'skipped', detail: `field ${table}.${field} not in safelist` };
  }

  const { error } = await ctx.supabase.from(table).update({ [field]: action.value }).eq('id', ctx.contactId);
  if (error) return { type: 'set_field', status: 'failed', detail: error.message };

  return { type: 'set_field', status: 'ok', detail: { table, field, value: action.value } };
}

// ── Top-level entrypoint ──────────────────────────────────────────────

export interface RunRulesInput {
  triggerEvent: string;
  context: Record<string, unknown>;
  contactId?: string | null;
  correlationId?: string;
}

export async function runMatchingRules(
  supabase: SupabaseClient,
  input: RunRulesInput,
): Promise<void> {
  const { data: rules, error } = await supabase
    .from('automation_rules')
    .select('id, code, enabled, source, conditions, actions')
    .eq('source', 'engine')
    .eq('enabled', true)
    .eq('trigger_event', input.triggerEvent);
  if (error) {
    log.warn('engine_load_rules_failed', { triggerEvent: input.triggerEvent, err: error.message });
    return;
  }

  for (const rule of rules ?? []) {
    const start = Date.now();
    const passes = evaluateConditions(rule.conditions, input.context);
    if (!passes) {
      await logAutomationRun(supabase, {
        ruleCode: rule.code,
        triggerEvent: input.triggerEvent,
        contactId: input.contactId,
        context: input.context,
        status: 'skipped',
        reason: 'conditions did not match',
        durationMs: Date.now() - start,
        correlationId: input.correlationId,
      });
      continue;
    }

    const actions = Array.isArray(rule.actions) ? rule.actions : [];
    const results: ActionResult[] = [];
    for (const action of actions) {
      results.push(await dispatchAction(action as Record<string, unknown>, {
        supabase, context: input.context, contactId: input.contactId, correlationId: input.correlationId,
      }));
    }

    const anyFailed = results.some((r) => r.status === 'failed');
    const allSkipped = results.length > 0 && results.every((r) => r.status === 'skipped');
    const status = anyFailed ? 'partial' : allSkipped ? 'skipped' : 'success';

    await logAutomationRun(supabase, {
      ruleCode: rule.code,
      triggerEvent: input.triggerEvent,
      contactId: input.contactId,
      context: input.context,
      actionResults: results as unknown as Array<Record<string, unknown>>,
      status,
      reason: anyFailed ? results.find((r) => r.status === 'failed')?.detail as string : undefined,
      durationMs: Date.now() - start,
      correlationId: input.correlationId,
    });
  }
}
