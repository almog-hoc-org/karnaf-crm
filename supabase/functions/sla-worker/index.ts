import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { logLeadEvent, transitionLeadStatus } from '../_shared/lead-service.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { env } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { getRuntimeConfig } from '../_shared/config-service.ts';
import { notifyTelegram } from '../_shared/notify-telegram.ts';
import { logAutomationRun } from '../_shared/automation-log.ts';

// Designed to be invoked by pg_cron via the Supabase scheduler. Every run
// emits operational queue items for leads that have crossed an SLA boundary
// since the last run, idempotently (ensurePendingQueueItem dedupes; DB-
// level uniqueness landed in migration 028).
//
// Error policy: every Supabase query checks .error. The previous shape
// destructured only .data and silently skipped leads when the query failed
// — meaning a temporary DB hiccup would mask SLA breaches. Now any query
// error makes the response non-2xx so alerting can fire.

function stillNeedsResponse(lead: { last_inbound_at?: string | null; last_outbound_at?: string | null }): boolean {
  if (!lead.last_inbound_at) return false;
  if (!lead.last_outbound_at) return true;
  const inboundMs = Date.parse(lead.last_inbound_at);
  const outboundMs = Date.parse(lead.last_outbound_at);
  if (!Number.isFinite(inboundMs)) return false;
  if (!Number.isFinite(outboundMs)) return true;
  return outboundMs < inboundMs;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  const expected = env.slaWorkerSecret();
  if (!expected) {
    log.error('sla_worker_secret_missing', { fn: 'sla-worker', correlationId });
    return jsonResponse(req, { error: 'Worker secret not configured' }, 500);
  }
  if (!verifyBearer(req, expected)) return jsonResponse(req, { error: 'Unauthorized' }, 401);

  try {
  const supabase = getServiceSupabase();
  const config = await getRuntimeConfig(supabase);

  const now = Date.now();
  const warn = new Date(now - config.slaThresholds.firstResponseWarnHours * 3600 * 1000).toISOString();
  const breach = new Date(now - config.slaThresholds.firstResponseBreachHours * 3600 * 1000).toISOString();
  const paymentBreach = new Date(now - config.slaThresholds.paymentPendingHours * 3600 * 1000).toISOString();
  const dormantBreach = new Date(now - (config.followUpDelays.nurtureHours * 7) * 3600 * 1000).toISOString();
  // Stuck-AI threshold: catches conversations where the AI dispatch failed
  // silently (provider error, validation block, etc.) before SLA warn fires.
  // Conservative default — 20 minutes — well under the 8h SLA warn.
  const stuckMinutes = 20;
  const stuck = new Date(now - stuckMinutes * 60 * 1000).toISOString();

  const counters: Record<string, number> = {
    sla_risk: 0, sla_breach: 0, payment_pending: 0, dormant: 0, ai_stuck: 0,
    deal_stalled: 0, meeting_outcome_pending: 0, phone_overdue: 0,
  };
  const queryErrors: Array<{ stage: string; message: string }> = [];

  const { data: slaRiskRows, error: slaRiskErr } = await supabase
    .from('leads')
    .select('id, last_inbound_at, last_outbound_at')
    .lt('last_inbound_at', warn)
    .eq('do_not_contact', false)
    .eq('removed_by_request', false);
  if (slaRiskErr) {
    queryErrors.push({ stage: 'sla_risk_query', message: slaRiskErr.message });
    log.error('sla_risk_query_failed', { fn: 'sla-worker', correlationId, err: slaRiskErr.message });
  }
  const slaRiskLeads = (slaRiskRows ?? []).filter(stillNeedsResponse);
  for (const lead of slaRiskLeads) {
    await ensurePendingQueueItem(supabase, {
      leadId: lead.id, queueType: 'sla_risk', priorityLevel: 2,
      reason: `No outbound response within ${config.slaThresholds.firstResponseWarnHours}h`,
      payloadJson: { correlationId, threshold: 'warn' },
    });
    counters.sla_risk++;
  }

  const { data: breachRows, error: breachErr } = await supabase
    .from('leads')
    .select('id, last_inbound_at, last_outbound_at')
    .lt('last_inbound_at', breach)
    .eq('do_not_contact', false)
    .eq('removed_by_request', false);
  if (breachErr) {
    queryErrors.push({ stage: 'sla_breach_query', message: breachErr.message });
    log.error('sla_breach_query_failed', { fn: 'sla-worker', correlationId, err: breachErr.message });
  }
  const breachLeads = (breachRows ?? []).filter(stillNeedsResponse);
  for (const lead of breachLeads) {
    await ensurePendingQueueItem(supabase, {
      leadId: lead.id, queueType: 'human_handoff', priorityLevel: 1,
      reason: `SLA breach: > ${config.slaThresholds.firstResponseBreachHours}h without response`,
      payloadJson: { correlationId, threshold: 'breach' },
    });
    await logLeadEvent(supabase, lead.id, 'sla_breach', 'system', { correlationId });
    counters.sla_breach++;
  }

  const { data: paymentStuck, error: paymentErr } = await supabase
    .from('leads')
    .select('id')
    .eq('lead_status', 'payment_pending')
    .lt('updated_at', paymentBreach);
  if (paymentErr) {
    queryErrors.push({ stage: 'payment_pending_query', message: paymentErr.message });
    log.error('payment_pending_query_failed', { fn: 'sla-worker', correlationId, err: paymentErr.message });
  }
  for (const lead of paymentStuck ?? []) {
    await ensurePendingQueueItem(supabase, {
      leadId: lead.id, queueType: 'payment_pending', priorityLevel: 1,
      reason: `Payment pending > ${config.slaThresholds.paymentPendingHours}h`,
      payloadJson: { correlationId },
    });
    counters.payment_pending++;
  }

  // AI-stuck: customer wrote, ownership says AI should be replying, but more
  // than `stuckMinutes` have passed without an outbound. Distinct from the
  // 8h SLA risk above: this catches silent AI drops (provider errors,
  // validation blocks) early enough for a human to intervene before the
  // customer cools off.
  const { data: stuckAiRows, error: stuckErr } = await supabase
    .from('leads')
    .select('id, last_inbound_at, last_outbound_at')
    .eq('ownership_mode', 'ai_active')
    .lt('last_inbound_at', stuck)
    .eq('do_not_contact', false)
    .eq('removed_by_request', false);
  if (stuckErr) {
    queryErrors.push({ stage: 'ai_stuck_query', message: stuckErr.message });
    log.error('ai_stuck_query_failed', { fn: 'sla-worker', correlationId, err: stuckErr.message });
  }
  const stuckAiLeads = (stuckAiRows ?? []).filter(stillNeedsResponse);
  for (const lead of stuckAiLeads) {
    await ensurePendingQueueItem(supabase, {
      leadId: lead.id, queueType: 'ai_stuck', priorityLevel: 2,
      reason: `AI לא הגיב תוך ${stuckMinutes} דק׳ — נדרשת בדיקה`,
      payloadJson: { correlationId, threshold: 'ai_stuck', stuckMinutes },
    });
    counters.ai_stuck++;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Tier 0.B — close the three "leads fall between chairs" gaps that the
  // old sla-worker missed entirely. Each watcher emits a work_queue row
  // with a queue_type that the attention_inbox RPC picks up so Mia sees
  // the stuck deal/meeting/phone-pending in her morning view.
  // ─────────────────────────────────────────────────────────────────────

  // B1 — deal_stalled: an OPEN deal whose contact has had no activity
  // within a track-specific window. The thresholds come from the v4 spec:
  // investor mentorship is hottest (warm leads going cold fast), program
  // is the slowest (digital course, more nurture-tolerant), presale is
  // in between.
  const dealStallDays: Record<string, number> = {
    investor_mentorship: 2,
    presale: 7,
    program: 3,
  };
  const maxDealStallMs = Math.max(...Object.values(dealStallDays)) * 24 * 3600 * 1000;
  const dealStallEarliest = new Date(now - maxDealStallMs).toISOString();
  const { data: openDeals, error: dealErr } = await supabase
    .from('deals')
    .select('id, lead_id, track, stage, updated_at, created_at')
    .eq('status', 'open');
  if (dealErr) {
    queryErrors.push({ stage: 'deal_stalled_query', message: dealErr.message });
    log.error('deal_stalled_query_failed', { fn: 'sla-worker', correlationId, err: dealErr.message });
  }
  for (const deal of openDeals ?? []) {
    const threshold = dealStallDays[deal.track as keyof typeof dealStallDays] ?? 5;
    const cutoff = new Date(now - threshold * 24 * 3600 * 1000).toISOString();
    // Most recent activity on the contact — proxies "is anyone working
    // this deal?". Cheap one-row lookup via the (contact_id, occurred_at desc)
    // index from migration 054.
    const { data: lastActivity } = await supabase
      .from('activities')
      .select('occurred_at')
      .eq('contact_id', deal.lead_id)
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastSeen = lastActivity?.occurred_at ?? deal.created_at;
    if (lastSeen >= cutoff) continue;
    // Skip very old deals that have already been flagged once and ignored —
    // the dealStallEarliest bound stops a runaway alert flood the first time
    // this worker boots up against a long-quiet pipeline.
    if (lastSeen < dealStallEarliest && deal.updated_at < dealStallEarliest) continue;
    await ensurePendingQueueItem(supabase, {
      leadId: deal.lead_id, queueType: 'deal_stalled', priorityLevel: deal.track === 'investor_mentorship' ? 1 : 2,
      reason: `עסקה פתוחה במסלול ${deal.track} ללא פעילות ${threshold} ימים`,
      payloadJson: { correlationId, dealId: deal.id, track: deal.track, stage: deal.stage, lastSeen, threshold },
    });
    counters.deal_stalled++;
  }

  // B2 — meeting_outcome_pending: a meeting whose starts_at passed more
  // than an hour ago but status is still 'scheduled'. Either the meeting
  // happened and nobody logged it, or it didn't and nobody cancelled.
  // Either way, Mia needs to close the loop.
  const meetingGraceCutoff = new Date(now - 60 * 60 * 1000).toISOString();
  const { data: pendingMeetings, error: meetingErr } = await supabase
    .from('meetings')
    .select('id, lead_id, meeting_type, starts_at, deal_id')
    .eq('status', 'scheduled')
    .lt('starts_at', meetingGraceCutoff);
  if (meetingErr) {
    queryErrors.push({ stage: 'meeting_pending_query', message: meetingErr.message });
    log.error('meeting_pending_query_failed', { fn: 'sla-worker', correlationId, err: meetingErr.message });
  }
  for (const meeting of pendingMeetings ?? []) {
    await ensurePendingQueueItem(supabase, {
      leadId: meeting.lead_id, queueType: 'meeting_outcome_pending', priorityLevel: 2,
      reason: `פגישת ${meeting.meeting_type} עברה — סטטוס עדיין ״מתוכננת״`,
      payloadJson: { correlationId, meetingId: meeting.id, startsAt: meeting.starts_at, dealId: meeting.deal_id },
    });
    counters.meeting_outcome_pending++;
  }

  // B3 — phone_overdue: a lead marked phone_sales_pending for more than
  // 24h with no logged phone call. This is the single biggest "fell
  // between chairs" pattern Almog cited — the bot escalates to phone,
  // Mia sees it, intends to call later, forgets.
  const phoneOverdueCutoff = new Date(now - 24 * 3600 * 1000).toISOString();
  const { data: phonePending, error: phonePendingErr } = await supabase
    .from('leads')
    .select('id, last_human_touch_at, updated_at')
    .eq('ownership_mode', 'phone_sales_pending')
    .or(`last_human_touch_at.is.null,last_human_touch_at.lt.${phoneOverdueCutoff}`);
  if (phonePendingErr) {
    queryErrors.push({ stage: 'phone_overdue_query', message: phonePendingErr.message });
    log.error('phone_overdue_query_failed', { fn: 'sla-worker', correlationId, err: phonePendingErr.message });
  }
  for (const lead of phonePending ?? []) {
    // Verify there is NO phone_call_logged task in the last 24h — Mia may
    // have called and we shouldn't re-flag her.
    const { data: recentCall } = await supabase
      .from('lead_tasks')
      .select('id')
      .eq('lead_id', lead.id)
      .eq('task_type', 'phone_call_logged')
      .gte('created_at', phoneOverdueCutoff)
      .limit(1)
      .maybeSingle();
    if (recentCall) continue;
    await ensurePendingQueueItem(supabase, {
      leadId: lead.id, queueType: 'phone_overdue', priorityLevel: 1,
      reason: 'הליד סומן לשיחת טלפון ועברו 24 שעות ללא תיעוד שיחה',
      payloadJson: { correlationId },
    });
    counters.phone_overdue++;
  }

  // Dormant: nurture leads idle for > 7 nurtureHours.
  const { data: dormantLeads, error: dormantErr } = await supabase
    .from('leads')
    .select('id, lead_status')
    .in('lead_status', ['nurture', 'responded'])
    .lt('updated_at', dormantBreach);
  if (dormantErr) {
    queryErrors.push({ stage: 'dormant_query', message: dormantErr.message });
    log.error('dormant_query_failed', { fn: 'sla-worker', correlationId, err: dormantErr.message });
  }
  for (const lead of dormantLeads ?? []) {
    await transitionLeadStatus(supabase, lead.id, 'dormant', 'system', 'sla_worker');
    await ensurePendingQueueItem(supabase, {
      leadId: lead.id, queueType: 'dormant_review', priorityLevel: 3,
      reason: 'Dormant lead; review for reactivation',
      payloadJson: { correlationId },
    });
    counters.dormant++;
    // Wire to automation catalog so the admin UI shows per-lead
    // "automation history". B8 is the spec name for dormant
    // resurrection — at this point the lead has *become* dormant,
    // and the resurrection nudge will be queued for human follow-up.
    await logAutomationRun(supabase, {
      ruleCode: 'b8_dormant_resurrect_14d',
      triggerEvent: 'sla_tick',
      contactId: lead.id,
      context: { previousStatus: lead.lead_status, dormantBreach },
      actionResults: [{ kind: 'queue_item_created', queue_type: 'dormant_review' }],
      status: 'success',
      correlationId,
    });
  }

  const hasUrgent = counters.sla_breach > 0 || counters.payment_pending > 0
    || counters.ai_stuck > 0 || counters.deal_stalled > 0
    || counters.meeting_outcome_pending > 0 || counters.phone_overdue > 0;
  if (hasUrgent) {
    const lines: string[] = [];
    if (counters.sla_breach > 0) lines.push(`• פריצת SLA: ${counters.sla_breach} לידים ללא מענה`);
    if (counters.phone_overdue > 0) lines.push(`• שיחת טלפון באיחור: ${counters.phone_overdue} לידים מעל 24ש׳`);
    if (counters.deal_stalled > 0) lines.push(`• עסקאות תקועות: ${counters.deal_stalled}`);
    if (counters.meeting_outcome_pending > 0) lines.push(`• פגישות לסיכום: ${counters.meeting_outcome_pending}`);
    if (counters.ai_stuck > 0) lines.push(`• AI תקוע: ${counters.ai_stuck} לידים מחכים מעל ${stuckMinutes} דק׳`);
    if (counters.payment_pending > 0) lines.push(`• תשלום תקוע: ${counters.payment_pending} לידים`);
    if (counters.sla_risk > 0) lines.push(`• סיכון SLA: ${counters.sla_risk} לידים מתקרבים לסף`);
    if (counters.dormant > 0) lines.push(`• הועברו ל-dormant: ${counters.dormant}`);
    await notifyTelegram({
      source: 'sla-worker',
      severity: counters.sla_breach > 0 || counters.phone_overdue > 0 ? 'error' : 'warn',
      title: 'Karnaf CRM — SLA tick',
      lines,
      link: 'https://karnaf-crm.vercel.app/inbox',
      correlationId,
    });
  }

  const ok = queryErrors.length === 0;
  log.info('sla_worker_run', { fn: 'sla-worker', correlationId, counters, queryErrors });
  return jsonResponse(req, { ok, counters, queryErrors, correlationId }, ok ? 200 : 500);
  } catch (err) {
    const message = err instanceof Error
      ? `${err.name}: ${err.message}`
      : JSON.stringify(err, Object.getOwnPropertyNames(err));
    log.error('sla_worker_unhandled', { fn: 'sla-worker', correlationId, err: message });
    return jsonResponse(req, { ok: false, error: message, correlationId }, 500);
  }
});
