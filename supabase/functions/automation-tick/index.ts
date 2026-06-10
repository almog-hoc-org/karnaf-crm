// /automation-tick — Tier 4.A.3
//
// Cron-driven entrypoint for the engine. Runs every 10 minutes from
// pg_cron. Scans active leads and fires `time.elapsed` rules against
// each via the engine. Engine evaluates conditions; only rules whose
// conditions match the lead actually act.
//
// Why a single tick fn for all time-based rules:
// * One place to bound work (cap lead-scan size, skip the do_not_contact
//   set, exclude won deals upstream).
// * Cheap to add new time-elapsed rules — just insert into automation_rules
//   with source='engine', trigger_event='time.elapsed', conditions+actions.
//   No code change needed.
//
// The context this tick builds is the contract every time-based rule
// can use:
//   { lead: <columns + derived fields>, deal: <newest open>, partner: <if any> }
// Add fields as new rules need them; keep the shape stable so existing
// rules don't break.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { env } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { runMatchingRules } from '../_shared/automation-engine.ts';
import { advanceDueRuns } from '../_shared/journey-runner.ts';

const TRIGGER = 'time.elapsed';
// Hard cap so a runaway query doesn't burn all our function time.
// 500 leads × <50ms each (engine + rule evals) is well within the
// 60-second function budget.
const MAX_LEADS_PER_TICK = 500;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const correlationId = correlationFromRequest(req);

  // Bearer-secret auth — pg_cron sends this with the configured token.
  // Same shape as sla-worker / daily-sales-inbox.
  const expected = env.automationTickSecret();
  if (!expected) {
    log.error('tick_secret_missing', { fn: 'automation-tick', correlationId });
    return jsonResponse(req, { error: 'Worker secret not configured' }, 500);
  }
  if (!verifyBearer(req, expected)) return jsonResponse(req, { error: 'Unauthorized' }, 401);

  const supabase = getServiceSupabase();

  // Early-exit if no engine rules are listening for time.elapsed.
  // Avoids the lead scan entirely on a fresh deployment.
  const { count: ruleCount } = await supabase
    .from('automation_rules')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'engine')
    .eq('enabled', true)
    .eq('trigger_event', TRIGGER);
  if (!ruleCount || ruleCount === 0) {
    log.info('tick_no_rules', { fn: 'automation-tick', correlationId });
    return jsonResponse(req, { ok: true, scanned: 0, rules: 0 });
  }

  // Scan leads that could plausibly match any time-based rule. The
  // engine re-checks per-rule conditions; this query is just the
  // coarse filter. Skip muted leads + leads that have moved on +
  // leads currently in a human-owned handback or pending-phone state
  // — an automation that fires while Mia is mid-conversation would
  // step on her with an "AI" message the customer would attribute
  // to her. Audit Tier 5.B flagged this as critical.
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, full_name, phone, email, city, product_interest, do_not_contact, removed_by_request, created_at, lead_status, ownership_mode')
    .eq('do_not_contact', false)
    .eq('removed_by_request', false)
    .not('lead_status', 'in', '(won,lost,suppressed)')
    .not('ownership_mode', 'in', '(mia_active,phone_sales_pending)')
    .order('created_at', { ascending: true })
    .limit(MAX_LEADS_PER_TICK);

  if (error) {
    log.error('tick_query_failed', { fn: 'automation-tick', correlationId, err: error.message });
    return jsonResponse(req, { error: error.message }, 500);
  }

  let fired = 0;
  for (const lead of leads ?? []) {
    // Build the per-lead context. The shape mirrors the rule's
    // condition paths (`lead.product_interest`, `lead.hours_since_intake`).
    const hoursSinceIntake = (Date.now() - new Date(lead.created_at).getTime()) / 3600000;

    // Whether this lead has ever bought a program track. Cheap query
    // — partial index on deals(status, track) would make it cheaper
    // still. Skip for now; volume is low.
    const { data: wonProgram } = await supabase
      .from('deals')
      .select('id', { head: false })
      .eq('lead_id', lead.id)
      .eq('track', 'program')
      .eq('status', 'won')
      .limit(1)
      .maybeSingle();

    const firstName = lead.full_name?.split(/\s+/u)[0] ?? '';
    const context = {
      lead: {
        id: lead.id,
        full_name: lead.full_name,
        first_name: firstName,
        phone: lead.phone,
        email: lead.email,
        city: lead.city,
        product_interest: lead.product_interest,
        do_not_contact: lead.do_not_contact,
        lead_status: lead.lead_status,
        ownership_mode: lead.ownership_mode,
        hours_since_intake: Math.round(hoursSinceIntake * 10) / 10,
        has_won_program: !!wonProgram,
      },
    };

    await runMatchingRules(supabase, {
      triggerEvent: TRIGGER,
      context,
      contactId: lead.id,
      correlationId,
    });
    fired++;
  }

  // Tier 4.B — second pass: advance any due journey_runs. Independent
  // from the rule scan above, so a slow journeys step can't block
  // time.elapsed rules and vice versa. The runner already caps work
  // (MAX_RUNS_PER_TICK) so the combined budget is bounded.
  const journeySummary = await advanceDueRuns(supabase, correlationId);

  log.info('tick_done', {
    fn: 'automation-tick', correlationId,
    scanned: fired, rules: ruleCount,
    journeys_processed: journeySummary.processed,
    journeys_completed: journeySummary.completed,
    journeys_failed: journeySummary.failed,
  });
  return jsonResponse(req, {
    ok: true, scanned: fired, rules: ruleCount,
    journeys: journeySummary,
  });
});
