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
import { buildLeadContextFromRow } from '../_shared/event-context.ts';

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

  // Tier 7.A.5 — accumulate per-pass errors. Each pass continues
  // independently (a journey advance failure shouldn't block the time
  // .elapsed scan); the orchestrator returns 500 at the end if any pass
  // failed so pg_cron retries on the next tick.
  const tickErrors: string[] = [];
  // Tier 7.B.6 — track caps hit; if a pass touched MAX_LEADS_PER_TICK
  // or MAX_RUNS_PER_TICK, the next tick will catch the leftover work
  // but admins should know we're behind.
  const capBreaches: string[] = [];

  // Scan leads that could plausibly match any time-based rule. The
  // engine re-checks per-rule conditions; this query is just the
  // coarse filter. Skip muted leads + leads that have moved on +
  // leads currently in a human-owned handback or pending-phone state
  // — an automation that fires while Mia is mid-conversation would
  // step on her with an "AI" message the customer would attribute
  // to her. Audit Tier 5.B flagged this as critical.
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, full_name, phone, email, city, product_interest, intake_segment, primary_track, do_not_contact, removed_by_request, source, created_at, last_inbound_at, last_outbound_at, lead_status, ownership_mode, lead_heat')
    .eq('do_not_contact', false)
    .eq('removed_by_request', false)
    .not('lead_status', 'in', '(won,lost,suppressed)')
    .not('ownership_mode', 'in', '(mia_active,phone_sales_pending)')
    .order('created_at', { ascending: true })
    .limit(MAX_LEADS_PER_TICK);

  if (error) {
    log.error('tick_query_failed', { fn: 'automation-tick', correlationId, err: error.message });
    tickErrors.push(`leads_query: ${error.message}`);
  }
  if ((leads?.length ?? 0) >= MAX_LEADS_PER_TICK) capBreaches.push('leads_scan');

  let fired = 0;
  for (const lead of leads ?? []) {
    // Tier 7.B.1 — canonical lead context built from the already-loaded
    // row + derived fields (program membership, has_won_program). One
    // function returns the same 18-field shape every other emitter uses.
    const leadCtx = await buildLeadContextFromRow(supabase, lead, { includeDerived: true });
    await runMatchingRules(supabase, {
      triggerEvent: TRIGGER,
      context: { lead: leadCtx },
      contactId: lead.id,
      correlationId,
    });
    fired++;
  }

  // Tier 4.B — second pass: advance any due journey_runs. Independent
  // from the rule scan above, so a slow journeys step can't block
  // time.elapsed rules and vice versa. The runner already caps work
  // (MAX_RUNS_PER_TICK) so the combined budget is bounded.
  // Tier 7.A.5 + 7.B.6 — surface the runner's query error + cap signal.
  const journeySummary = await advanceDueRuns(supabase, correlationId);
  if (journeySummary.query_error) tickErrors.push(`journey_advance: ${journeySummary.query_error}`);
  if (journeySummary.cap_reached) capBreaches.push('journey_advance');

  // Tier 4.D.5 — third pass: investor_mentorship deals without a
  // partner. Self-healing — a deal created anywhere (admin-actions,
  // leads-intake, webinar-events, whatsapp-webhook) gets a partner
  // within 10 minutes regardless of whether the creation path emitted
  // an event. Emits `deal.investor_open` per matching deal so engine
  // rules listening on that trigger can act (assign_partner, send
  // C5/C6 templates, notify_internal).
  let unassignedFired = 0;
  // Tier 7.B.1 — select the full leads.* shape the builder consumes
  // so we don't have to round-trip per deal.
  const { data: unassignedDeals, error: dealsErr } = await supabase
    .from('deals')
    .select('id, lead_id, track, value, currency, created_at, leads(id, full_name, phone, email, city, product_interest, intake_segment, primary_track, lead_status, ownership_mode, lead_heat, do_not_contact, removed_by_request, source, created_at, last_inbound_at, last_outbound_at)')
    .eq('status', 'open')
    .eq('track', 'investor_mentorship')
    .is('partner_id', null)
    .order('created_at', { ascending: true })
    .limit(50);
  if (dealsErr) {
    // Tier 7.A.5 — fatal-on-error for this pass too. The full tick
    // collects errors and fails the response so pg_cron logs red.
    tickErrors.push(`unassigned_deals_query: ${dealsErr.message}`);
    log.error('tick_unassigned_deals_query_failed', { fn: 'automation-tick', correlationId, err: dealsErr.message });
  } else {
    for (const deal of unassignedDeals ?? []) {
      const leadRow = deal.leads as unknown as { id: string; do_not_contact?: boolean } | null;
      if (!leadRow || leadRow.do_not_contact) continue;
      // Use the loaded row directly — no extra query.
      const leadCtxInvestor = await buildLeadContextFromRow(supabase, deal.leads as never);
      await runMatchingRules(supabase, {
        triggerEvent: 'deal.investor_open',
        context: {
          lead: leadCtxInvestor,
          deal: { id: deal.id, track: deal.track, value: deal.value, currency: deal.currency },
        },
        contactId: leadRow.id,
        correlationId,
      });
      unassignedFired++;
    }
  }

  // Tier 7.B.6 — record cap hit on unassigned deals too.
  if ((unassignedDeals?.length ?? 0) >= 50) capBreaches.push('unassigned_investor_deals');

  // Tier 7.B.6 — log every cap breach as a warn so admins see "we're
  // running behind" before customer-facing latency becomes a complaint.
  if (capBreaches.length > 0) {
    log.warn('tick_cap_breach', { fn: 'automation-tick', correlationId, passes: capBreaches });
  }

  log.info('tick_done', {
    fn: 'automation-tick', correlationId,
    scanned: fired, rules: ruleCount,
    journeys_processed: journeySummary.processed,
    journeys_completed: journeySummary.completed,
    journeys_failed: journeySummary.failed,
    unassigned_investor_deals_fired: unassignedFired,
    cap_breaches: capBreaches,
    errors: tickErrors,
  });
  // Tier 7.A.5 — fatal-on-error orchestration. If any pass errored out
  // at the query level, return 500 so pg_cron logs red and retries on
  // the next tick. Per-row failures inside the passes stay as warnings
  // (already logged) — they're per-contact recoverable.
  if (tickErrors.length > 0) {
    return jsonResponse(req, {
      ok: false,
      scanned: fired, rules: ruleCount,
      journeys: journeySummary,
      unassigned_investor_deals_fired: unassignedFired,
      cap_breaches: capBreaches,
      errors: tickErrors,
    }, 500);
  }

  // Tier 7.B.3 — heartbeat write. Lets the Dashboard banner detect
  // cron drift without external monitoring. Best-effort; a write
  // failure here doesn't change the tick's reported success — the
  // dashboard would still see staleness within 15 min.
  await supabase.from('system_heartbeats').upsert({
    name: 'automation_tick',
    last_ok_at: new Date().toISOString(),
    last_run_id: correlationId,
    metadata: {
      scanned: fired, rules: ruleCount,
      journeys_processed: journeySummary.processed,
      unassigned_fired: unassignedFired,
    },
  }, { onConflict: 'name' });

  return jsonResponse(req, {
    ok: true, scanned: fired, rules: ruleCount,
    journeys: journeySummary,
    unassigned_investor_deals_fired: unassignedFired,
    cap_breaches: capBreaches,
  });
});
