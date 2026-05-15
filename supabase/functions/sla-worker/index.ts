import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { logLeadEvent, transitionLeadStatus } from '../_shared/lead-service.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { env } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { getRuntimeConfig } from '../_shared/config-service.ts';
import { notifyTelegram } from '../_shared/notify-telegram.ts';

// Designed to be invoked by pg_cron via the Supabase scheduler. Every run
// emits operational queue items for leads that have crossed an SLA boundary
// since the last run, idempotently (ensurePendingQueueItem dedupes; DB-
// level uniqueness landed in migration 028).
//
// Error policy: every Supabase query checks .error. The previous shape
// destructured only .data and silently skipped leads when the query failed
// — meaning a temporary DB hiccup would mask SLA breaches. Now any query
// error makes the response non-2xx so alerting can fire.

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

  const supabase = getServiceSupabase();
  const config = await getRuntimeConfig(supabase);

  const now = Date.now();
  const warn = new Date(now - config.slaThresholds.firstResponseWarnHours * 3600 * 1000).toISOString();
  const breach = new Date(now - config.slaThresholds.firstResponseBreachHours * 3600 * 1000).toISOString();
  const paymentBreach = new Date(now - config.slaThresholds.paymentPendingHours * 3600 * 1000).toISOString();
  const dormantBreach = new Date(now - (config.followUpDelays.nurtureHours * 7) * 3600 * 1000).toISOString();

  const counters: Record<string, number> = { sla_risk: 0, sla_breach: 0, payment_pending: 0, dormant: 0 };
  const queryErrors: Array<{ stage: string; message: string }> = [];

  const { data: slaRiskLeads, error: slaRiskErr } = await supabase
    .from('leads')
    .select('id')
    .lt('last_inbound_at', warn)
    .or('last_outbound_at.is.null,last_outbound_at.lt.last_inbound_at')
    .eq('do_not_contact', false)
    .eq('removed_by_request', false);
  if (slaRiskErr) {
    queryErrors.push({ stage: 'sla_risk_query', message: slaRiskErr.message });
    log.error('sla_risk_query_failed', { fn: 'sla-worker', correlationId, err: slaRiskErr.message });
  }
  for (const lead of slaRiskLeads ?? []) {
    await ensurePendingQueueItem(supabase, {
      leadId: lead.id, queueType: 'sla_risk', priorityLevel: 2,
      reason: `No outbound response within ${config.slaThresholds.firstResponseWarnHours}h`,
      payloadJson: { correlationId, threshold: 'warn' },
    });
    counters.sla_risk++;
  }

  const { data: breachLeads, error: breachErr } = await supabase
    .from('leads')
    .select('id')
    .lt('last_inbound_at', breach)
    .or('last_outbound_at.is.null,last_outbound_at.lt.last_inbound_at')
    .eq('do_not_contact', false)
    .eq('removed_by_request', false);
  if (breachErr) {
    queryErrors.push({ stage: 'sla_breach_query', message: breachErr.message });
    log.error('sla_breach_query_failed', { fn: 'sla-worker', correlationId, err: breachErr.message });
  }
  for (const lead of breachLeads ?? []) {
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
  }

  if (counters.sla_breach > 0 || counters.payment_pending > 0) {
    const lines: string[] = [];
    if (counters.sla_breach > 0) lines.push(`• פריצת SLA: ${counters.sla_breach} לידים ללא מענה`);
    if (counters.payment_pending > 0) lines.push(`• תשלום תקוע: ${counters.payment_pending} לידים`);
    if (counters.sla_risk > 0) lines.push(`• סיכון SLA: ${counters.sla_risk} לידים מתקרבים לסף`);
    if (counters.dormant > 0) lines.push(`• הועברו ל-dormant: ${counters.dormant}`);
    await notifyTelegram({
      source: 'sla-worker',
      severity: counters.sla_breach > 0 ? 'error' : 'warn',
      title: 'Karnaf CRM — SLA tick',
      lines,
      link: 'https://karnaf-crm.vercel.app/queue',
      correlationId,
    });
  }

  const ok = queryErrors.length === 0;
  log.info('sla_worker_run', { fn: 'sla-worker', correlationId, counters, queryErrors });
  return jsonResponse(req, { ok, counters, queryErrors, correlationId }, ok ? 200 : 500);
});
