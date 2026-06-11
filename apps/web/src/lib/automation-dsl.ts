// Tier 5.D.4 — frontend mirror of the server's DSL evaluator.
//
// This is a *pure*-function port of evaluateConditions / resolvePath
// from supabase/functions/_shared/automation-engine.ts. Kept in sync
// by convention: when you add a new operator to the server, mirror
// here. The two implementations must agree, otherwise a rule that
// previews as "passes" client-side could "skip" server-side, which
// would erode trust in the editor.
//
// Why duplicate instead of calling the server: the "test against
// this lead" UX needs to be instant (per-keystroke or one-click).
// A round-trip through an edge function would feel laggy and would
// also require a new endpoint + auth. Pure JS in the browser is
// the right grain.

export type ConditionOp =
  | 'eq' | 'neq' | 'in' | 'not_in'
  | 'gte' | 'lte' | 'gt' | 'lt'
  | 'exists' | 'not_exists';

export interface LeafCondition {
  field: string;
  op: ConditionOp;
  value?: unknown;
}

export type ConditionTree =
  | { all: ConditionTree[] }
  | { any: ConditionTree[] }
  | LeafCondition
  | Record<string, never>;

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

export interface EvalTraceLeaf {
  field: string;
  op: ConditionOp;
  expected: unknown;
  actual: unknown;
  pass: boolean;
}

export interface EvalResult {
  pass: boolean;
  // Per-leaf trace so the UI can show "פעולה נכשלה כי lead.product_interest = null".
  trace: EvalTraceLeaf[];
}

export function evaluateConditionsWithTrace(
  conditions: unknown,
  context: Record<string, unknown>,
): EvalResult {
  const trace: EvalTraceLeaf[] = [];
  const pass = evalInner(conditions, context, trace);
  return { pass, trace };
}

function evalInner(
  conditions: unknown,
  context: Record<string, unknown>,
  trace: EvalTraceLeaf[],
): boolean {
  if (!conditions || typeof conditions !== 'object') return true;
  const c = conditions as Record<string, unknown>;
  if (Object.keys(c).length === 0) return true;

  if (Array.isArray(c.all)) {
    return (c.all as ConditionTree[]).every((sub) => evalInner(sub, context, trace));
  }
  if (Array.isArray(c.any)) {
    return (c.any as ConditionTree[]).some((sub) => evalInner(sub, context, trace));
  }

  const field = c.field as string | undefined;
  const op = c.op as ConditionOp | undefined;
  if (!field || !op) return false;
  const actual = resolvePath(context, field);
  const expected = c.value;
  const pass = leafOp(actual, op, expected);
  trace.push({ field, op, expected, actual, pass });
  return pass;
}

function leafOp(actual: unknown, op: ConditionOp, expected: unknown): boolean {
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

// Helper: build a sample context object for a given trigger event.
// Used by the AutomationsPage editor's "load sample" button so admin
// doesn't have to invent context shapes from scratch.
export function sampleContextForTrigger(triggerEvent: string): Record<string, unknown> {
  switch (triggerEvent) {
    case 'lead.created':
      return {
        lead: {
          id: '00000000-0000-0000-0000-000000000000',
          full_name: 'דנה כהן',
          first_name: 'דנה',
          phone: '+972501234567',
          email: 'dana@example.com',
          city: 'תל אביב',
          product_interest: 'program',
          intake_segment: 'high_intent_qualified',
          do_not_contact: false,
          primary_track: 'program',
          source: 'whatsapp_direct',
        },
      };
    case 'deal.won':
      return {
        lead: {
          id: '00000000-0000-0000-0000-000000000000',
          full_name: 'דנה כהן',
          first_name: 'דנה',
          phone: '+972501234567',
          do_not_contact: false,
          product_interest: 'program',
        },
        deal: { id: '00000000-0000-0000-0000-000000000001', track: 'program', value: 12000, currency: 'ILS' },
      };
    case 'time.elapsed':
      return {
        lead: {
          id: '00000000-0000-0000-0000-000000000000',
          full_name: 'דנה כהן',
          first_name: 'דנה',
          phone: '+972501234567',
          email: 'dana@example.com',
          city: 'תל אביב',
          product_interest: 'program',
          intake_segment: 'high_intent_qualified',
          primary_track: 'program',
          lead_status: 'first_contact_sent',
          ownership_mode: 'ai_active',
          lead_heat: 'warm',
          do_not_contact: false,
          source: 'whatsapp_direct',
          hours_since_intake: 36,
          hours_since_last_inbound: 28,
          hours_since_last_outbound: 12,
          has_won_program: false,
          is_program_member: false,
          days_since_program_join: null,
          program_progress_stage: null,
        },
      };
    // Tier 7.D.2 — sample contexts for the remaining triggers so
    // /automations rule editing test panel doesn't render a stub.
    case 'deal.investor_open':
      return {
        lead: {
          id: '00000000-0000-0000-0000-000000000000',
          full_name: 'יובל לוי',
          first_name: 'יובל',
          phone: '+972502345678',
          do_not_contact: false,
          primary_track: 'investor_mentorship',
          product_interest: 'investor_mentorship',
          lead_status: 'qualified',
          ownership_mode: 'ai_active',
        },
        deal: {
          id: '00000000-0000-0000-0000-000000000010',
          track: 'investor_mentorship',
          value: 18000,
          currency: 'ILS',
          partner_id: null,
        },
      };
    case 'lead.dormant':
      return {
        lead: {
          id: '00000000-0000-0000-0000-000000000000',
          full_name: 'דנה כהן',
          first_name: 'דנה',
          phone: '+972501234567',
          do_not_contact: false,
          primary_track: 'program',
          product_interest: 'program',
          lead_status: 'dormant',
          ownership_mode: 'ai_active',
          hours_since_last_inbound: 360,
          hours_since_last_outbound: 96,
          has_won_program: false,
          is_program_member: false,
        },
      };
    case 'deal.lost':
      return {
        lead: {
          id: '00000000-0000-0000-0000-000000000000',
          full_name: 'יובל לוי',
          first_name: 'יובל',
          phone: '+972502345678',
          do_not_contact: false,
          primary_track: 'investor_mentorship',
          lead_status: 'lost',
        },
        deal: { id: '00000000-0000-0000-0000-000000000010', track: 'investor_mentorship', value: 0, currency: 'ILS' },
        lost_reason: 'price objection',
      };
    case 'project.recruiting':
      return {
        lead: {
          id: '00000000-0000-0000-0000-000000000000',
          full_name: 'דנה כהן',
          first_name: 'דנה',
          phone: '+972501234567',
          city: 'תל אביב',
          do_not_contact: false,
          primary_track: 'presale',
          product_interest: 'contractor_group_purchase',
          lead_status: 'nurture',
        },
        project: {
          id: '00000000-0000-0000-0000-000000000020',
          name: 'פרויקט אלפא',
          city: 'נתניה',
          target_amount: 60_000_000,
          target_date: '2026-12-01',
          currency: 'ILS',
        },
        project_name: 'פרויקט אלפא',
        city: 'נתניה',
      };
    case 'lead.track_set':
      return {
        lead: {
          id: '00000000-0000-0000-0000-000000000000',
          full_name: 'דנה כהן',
          first_name: 'דנה',
          do_not_contact: false,
          primary_track: 'program',
        },
        previous_track: null,
        new_track: 'program',
      };
    default:
      return { lead: { id: 'sample', do_not_contact: false } };
  }
}
