// /automation-tick — the engine's cron entrypoint. Runs every 10 minutes.
//
// Four passes, each independent so one failing pass cannot block the others:
//   1. time.elapsed        — scan active leads, fire time-based engine rules
//   2. journeys            — advance due journey_runs
//   3. student check-ins   — biweekly programme touchpoints
//   4. lead journey mgr    — enrol leads into journeys
//   5. deal.investor_open  — investor deals still without a partner
//
// Passes 1 and 5 WERE DELETED BY A MERGE. Commits 72854e7 / 668f934
// resolved a conflict in favour of a 42-line version of this file, removing
// 201 lines including the entire time.elapsed scan and the investor-deal
// emitter. Five enabled rules — b3, b5, b6, b7, b14 — have therefore been
// dead ever since, while the rule tester in the admin UI kept reporting
// them green, because the tester evaluates conditions directly and never
// asks whether anything actually fires the trigger.
//
// Restoring them naively would be dangerous: the pipeline has been
// accumulating for months, so the first tick after a restore would fire
// against every lead that has silently qualified in the meantime. Hence
// DRY_RUN, below.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { env, optional, safeEqual } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { runMatchingRules, type RuleMatch } from '../_shared/automation-engine.ts';
import { advanceDueJourneys } from '../_shared/journey-runner.ts';
import { runBiweeklyStudentCheckins } from '../_shared/student-lifecycle.ts';
import { runLeadJourneyManager } from '../_shared/lead-journey-manager.ts';
import { buildLeadContextFromRow, type LeadRowForContext } from '../_shared/event-context.ts';

const TRIGGER = 'time.elapsed';

// Hard cap so a runaway query can't burn the whole function budget.
const MAX_LEADS_PER_TICK = 500;
const MAX_INVESTOR_DEALS_PER_TICK = 50;

const LEAD_SCAN_COLUMNS =
  'id, full_name, phone, email, city, product_interest, intake_segment, ' +
  'primary_track, do_not_contact, removed_by_request, snoozed_until, ' +
  'no_proactive_contact, ig_user_id, consent_email, source, source_campaign, ' +
  'created_at, last_inbound_at, last_outbound_at, lead_status, ownership_mode, lead_heat';

/**
 * The restored time-based passes stay in dry-run until AUTOMATION_TIME_RULES
 * is explicitly set to 'live'. In dry-run they evaluate every rule against
 * every scanned lead and report the matches — no sends, no audit rows, no
 * side effects — so the blast radius of switching them on is a number
 * someone can look at first.
 *
 * A `?dryRun=true` query param forces dry-run regardless, which is how the
 * report is produced on demand without touching the env var.
 */
function timeRulesLive(): boolean {
  return optional('AUTOMATION_TIME_RULES').toLowerCase() === 'live';
}

function verifyAnyBearer(req: Request, expectedSecrets: string[]): boolean {
  const header = req.headers.get('authorization') || '';
  if (!header.toLowerCase().startsWith('bearer ')) return false;
  const provided = header.slice(7).trim();
  return expectedSecrets.some((secret) => secret && safeEqual(provided, secret));
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  const expectedSecrets = [env.automationTickSecret(), env.slaWorkerSecret()].filter(Boolean);
  if (expectedSecrets.length === 0) {
    log.error('automation_tick_secret_missing', { fn: 'automation-tick', correlationId });
    return jsonResponse(req, { error: 'Worker secret not configured' }, 500);
  }
  if (!verifyAnyBearer(req, expectedSecrets)) return jsonResponse(req, { error: 'Unauthorized' }, 401);

  const dryRun = new URL(req.url).searchParams.get('dryRun') === 'true' || !timeRulesLive();
  const supabase = getServiceSupabase();

  const tickErrors: string[] = [];
  const capBreaches: string[] = [];

  // ── Pass 1: time.elapsed ────────────────────────────────────────────
  const timeRules = await runTimeElapsedPass(supabase, correlationId, dryRun, tickErrors, capBreaches);

  // ── Passes 2-4: journeys and lifecycle (unaffected by the merge) ─────
  let journeys: Awaited<ReturnType<typeof advanceDueJourneys>> | { error: string };
  try {
    journeys = await advanceDueJourneys(supabase, correlationId);
  } catch (err) {
    journeys = { error: String(err) };
    tickErrors.push(`journeys: ${String(err)}`);
  }

  let studentCheckins: unknown;
  try {
    studentCheckins = await runBiweeklyStudentCheckins(supabase, correlationId);
  } catch (err) {
    studentCheckins = { error: String(err) };
    tickErrors.push(`student_checkins: ${String(err)}`);
  }

  let leadJourney: unknown;
  try {
    leadJourney = await runLeadJourneyManager(supabase, correlationId);
  } catch (err) {
    leadJourney = { error: String(err) };
    tickErrors.push(`lead_journey_manager: ${String(err)}`);
  }

  // ── Pass 5: deal.investor_open ──────────────────────────────────────
  const investor = await runInvestorDealPass(supabase, correlationId, dryRun, tickErrors, capBreaches);

  if (capBreaches.length > 0) {
    log.warn('tick_cap_breach', { fn: 'automation-tick', correlationId, passes: capBreaches });
  }

  const summary = {
    dryRun,
    timeRules,
    investor,
    journeys,
    studentCheckins,
    leadJourney,
    capBreaches,
    errors: tickErrors,
  };

  // Heartbeat on every completed run, degraded or not — same reasoning as
  // sla-worker: it answers "is the scheduler firing", and gating it on
  // success turned one bad query into a permanent "worker is dead" banner.
  await supabase.from('system_heartbeats').upsert({
    name: 'automation_tick',
    last_ok_at: new Date().toISOString(),
    last_run_id: correlationId,
    metadata: summary,
  }, { onConflict: 'name' });

  log.info('automation_tick_run', { fn: 'automation-tick', correlationId, ...summary });
  return jsonResponse(req, { ok: tickErrors.length === 0, correlationId, ...summary },
    tickErrors.length > 0 ? 500 : 200);
});

async function runTimeElapsedPass(
  supabase: ReturnType<typeof getServiceSupabase>,
  correlationId: string,
  dryRun: boolean,
  tickErrors: string[],
  capBreaches: string[],
) {
  // Early exit before the lead scan when nothing is listening.
  const { count: ruleCount, error: ruleErr } = await supabase
    .from('automation_rules')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'engine')
    .eq('enabled', true)
    .eq('trigger_event', TRIGGER);
  if (ruleErr) {
    tickErrors.push(`time_rules_count: ${ruleErr.message}`);
    return { scanned: 0, rules: 0, matches: {} as Record<string, number>, dryRun };
  }
  if (!ruleCount) return { scanned: 0, rules: 0, matches: {} as Record<string, number>, dryRun };

  // Coarse filter; the engine re-checks each rule's own conditions. Muted
  // leads, closed leads, and leads a human is actively working are excluded
  // — an automation firing mid-conversation would put an "AI" message in
  // front of a customer who would read it as coming from their rep.
  const { data: leads, error } = await supabase
    .from('leads')
    .select(LEAD_SCAN_COLUMNS)
    .eq('do_not_contact', false)
    .eq('removed_by_request', false)
    .not('lead_status', 'in', '(won,lost,do_not_contact,removed_by_request,duplicate)')
    .not('ownership_mode', 'in', '(mia_active,phone_sales_pending)')
    .order('created_at', { ascending: true })
    .limit(MAX_LEADS_PER_TICK);
  if (error) {
    log.error('tick_query_failed', { fn: 'automation-tick', correlationId, err: error.message });
    tickErrors.push(`leads_query: ${error.message}`);
    return { scanned: 0, rules: ruleCount, matches: {} as Record<string, number>, dryRun };
  }
  if ((leads?.length ?? 0) >= MAX_LEADS_PER_TICK) capBreaches.push('leads_scan');

  const matches: Record<string, number> = {};
  const sampleLeads: Record<string, string[]> = {};
  let scanned = 0;
  // supabase-js infers the row shape from the select string literally, and a
  // string built by concatenation defeats that inference (it lands on
  // GenericStringError). The column list is shared with the investor pass on
  // purpose, so assert the shape here rather than duplicating the literal.
  const scannedLeads = (leads ?? []) as unknown as LeadRowForContext[];
  for (const lead of scannedLeads) {
    const leadCtx = await buildLeadContextFromRow(supabase, lead, { includeDerived: true });
    const fired = await runMatchingRules(supabase, {
      triggerEvent: TRIGGER,
      context: { lead: leadCtx },
      contactId: lead.id,
      correlationId,
      dryRun,
    });
    tallyMatches(fired, matches, sampleLeads);
    scanned++;
  }

  return { scanned, rules: ruleCount, matches, sampleLeads, dryRun };
}

async function runInvestorDealPass(
  supabase: ReturnType<typeof getServiceSupabase>,
  correlationId: string,
  dryRun: boolean,
  tickErrors: string[],
  capBreaches: string[],
) {
  // Self-healing: an investor_mentorship deal created by any path
  // (admin-actions, leads-intake, webinar-events, whatsapp-webhook) gets a
  // partner within ten minutes whether or not its creation path emitted an
  // event.
  const { data: deals, error } = await supabase
    .from('deals')
    .select(`id, lead_id, track, value, currency, created_at, leads(${LEAD_SCAN_COLUMNS})`)
    .eq('status', 'open')
    .eq('track', 'investor_mentorship')
    .is('partner_id', null)
    .order('created_at', { ascending: true })
    .limit(MAX_INVESTOR_DEALS_PER_TICK);
  if (error) {
    tickErrors.push(`unassigned_deals_query: ${error.message}`);
    log.error('tick_unassigned_deals_query_failed', { fn: 'automation-tick', correlationId, err: error.message });
    return { fired: 0, matches: {} as Record<string, number>, dryRun };
  }
  if ((deals?.length ?? 0) >= MAX_INVESTOR_DEALS_PER_TICK) capBreaches.push('unassigned_investor_deals');

  const matches: Record<string, number> = {};
  const sampleLeads: Record<string, string[]> = {};
  let fired = 0;
  for (const deal of deals ?? []) {
    const leadRow = deal.leads as unknown as { id: string; do_not_contact?: boolean } | null;
    if (!leadRow || leadRow.do_not_contact) continue;
    const leadCtx = await buildLeadContextFromRow(supabase, deal.leads as never);
    const hits = await runMatchingRules(supabase, {
      triggerEvent: 'deal.investor_open',
      context: {
        lead: leadCtx,
        deal: { id: deal.id, track: deal.track, value: deal.value, currency: deal.currency },
      },
      contactId: leadRow.id,
      correlationId,
      dryRun,
    });
    tallyMatches(hits, matches, sampleLeads);
    fired++;
  }
  return { fired, matches, sampleLeads, dryRun };
}

// Per-rule counts plus a handful of lead ids each, so a dry-run report says
// both "this rule would touch 240 leads" and "here are five of them to open
// and sanity-check before you turn it on".
function tallyMatches(
  hits: RuleMatch[],
  matches: Record<string, number>,
  sampleLeads: Record<string, string[]>,
) {
  for (const hit of hits) {
    matches[hit.ruleCode] = (matches[hit.ruleCode] ?? 0) + 1;
    const samples = sampleLeads[hit.ruleCode] ??= [];
    if (samples.length < 5 && hit.contactId) samples.push(hit.contactId);
  }
}
