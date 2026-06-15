import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { createLeadTask } from '../_shared/task-service.ts';
import { notifyTelegram } from '../_shared/notify-telegram.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { env } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

const STALE_INBOUND_MINUTES = 7;
const LOOKBACK_HOURS = 24;
const MEANINGFUL_OUTBOUND_SENDERS = ['ai', 'human', 'mia', 'staff', 'operator', 'admin', 'sales'];

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  const expected = env.slaWorkerSecret();
  if (!expected) return jsonResponse(req, { error: 'Watchdog secret not configured' }, 500);
  if (!verifyBearer(req, expected)) return jsonResponse(req, { error: 'Unauthorized' }, 401);

  const supabase = getServiceSupabase();
  const staleCutoff = new Date(Date.now() - STALE_INBOUND_MINUTES * 60_000).toISOString();
  const lookback = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();
  const counters: Record<string, number> = {
    ai_no_response: 0,
    handoff_no_response: 0,
    model_disabled: 0,
  };

  const { data: staleLeads, error: staleErr } = await supabase
    .from('leads')
    .select('id, full_name, ownership_mode, last_inbound_at, last_outbound_at')
    .gte('last_inbound_at', lookback)
    .lt('last_inbound_at', staleCutoff)
    .eq('do_not_contact', false)
    .eq('removed_by_request', false)
    .in('ownership_mode', ['ai_active', 'mia_active', 'phone_sales_pending'])
    .limit(50);
  if (staleErr) throw staleErr;

  const unrepliedLeads = [];
  for (const lead of staleLeads ?? []) {
    const hasTimestampReply = lead.last_outbound_at && Date.parse(lead.last_outbound_at) > Date.parse(lead.last_inbound_at);
    if (!hasTimestampReply) {
      unrepliedLeads.push(lead);
      continue;
    }

    const { data: meaningfulOutbound, error: meaningfulErr } = await supabase
      .from('messages')
      .select('id')
      .eq('lead_id', lead.id)
      .eq('direction', 'outbound')
      .in('sender_type', MEANINGFUL_OUTBOUND_SENDERS)
      .gt('created_at', lead.last_inbound_at)
      .limit(1)
      .maybeSingle();
    if (meaningfulErr) throw meaningfulErr;
    if (!meaningfulOutbound) unrepliedLeads.push(lead);
  }

  for (const lead of unrepliedLeads) {
    const isAiOwned = lead.ownership_mode === 'ai_active';
    const queueType = isAiOwned ? 'ai_stuck' : 'human_handoff';
    const reason = isAiOwned
      ? `AI-owned lead has inbound older than ${STALE_INBOUND_MINUTES}m with no outbound`
      : `Human-owned lead has inbound older than ${STALE_INBOUND_MINUTES}m with no outbound`;
    counters[isAiOwned ? 'ai_no_response' : 'handoff_no_response']++;

    const item = await ensurePendingQueueItem(supabase, {
      leadId: lead.id,
      queueType,
      priorityLevel: isAiOwned ? 1 : 2,
      reason,
      queueSummary: lead.full_name ?? null,
      payloadJson: {
        correlationId,
        lastInboundAt: lead.last_inbound_at,
        lastOutboundAt: lead.last_outbound_at,
        ownershipMode: lead.ownership_mode,
      },
    });

    if (item.created) {
      await createRepairTask(supabase, lead.id, isAiOwned ? 'repair_ai_no_response' : 'repair_handoff_no_response', reason, {
        correlationId,
        queueItemId: item.id,
      });
    }

    if (isAiOwned) {
      await triggerAiReplay(lead.id, correlationId);
    }
  }

  const { data: disabledDecisions, error: disabledErr } = await supabase
    .from('ai_decisions')
    .select('lead_id, created_at, model_name')
    .eq('execution_status', 'model_disabled')
    .gte('created_at', lookback)
    .limit(50);
  if (disabledErr) throw disabledErr;

  for (const decision of disabledDecisions ?? []) {
    if (!decision.lead_id) continue;
    const { data: lead, error: leadErr } = await supabase
      .from('leads')
      .select('last_outbound_at')
      .eq('id', decision.lead_id)
      .maybeSingle();
    if (leadErr) throw leadErr;
    if (lead?.last_outbound_at && Date.parse(lead.last_outbound_at) > Date.parse(decision.created_at)) {
      continue;
    }
    counters.model_disabled++;

    const item = await ensurePendingQueueItem(supabase, {
      leadId: decision.lead_id,
      queueType: 'ai_stuck',
      priorityLevel: 1,
      reason: 'AI model disabled in production; no reply was generated',
      queueSummary: String(decision.model_name ?? 'disabled'),
      payloadJson: {
        correlationId,
        decisionCreatedAt: decision.created_at,
      },
    });
    if (item.created) {
      await createRepairTask(supabase, decision.lead_id, 'repair_ai_model_disabled', 'Restore AI provider secrets/config and replay the lead.', {
        correlationId,
        queueItemId: item.id,
      });
    }
  }

  const total = counters.ai_no_response + counters.handoff_no_response + counters.model_disabled;
  if (total > 0) {
    await notifyTelegram({
      source: 'ai-watchdog',
      severity: counters.ai_no_response > 0 || counters.model_disabled > 0 ? 'critical' : 'error',
      title: 'Karnaf CRM AI watchdog',
      lines: [
        `AI no-response: ${counters.ai_no_response}`,
        `Handoff no-response: ${counters.handoff_no_response}`,
        `Model disabled: ${counters.model_disabled}`,
      ],
      link: 'https://karnaf-crm.vercel.app/queue',
      correlationId,
    });
  }

  await supabase.from('system_heartbeats').upsert({
    name: 'ai_watchdog',
    last_ok_at: new Date().toISOString(),
    last_run_id: correlationId,
    metadata: { counters },
  });

  log.info('ai_watchdog_run', { fn: 'ai-watchdog', correlationId, counters });
  return jsonResponse(req, { ok: true, counters, correlationId });
});

async function createRepairTask(
  supabase: ReturnType<typeof getServiceSupabase>,
  leadId: string,
  taskType: string,
  description: string,
  payloadJson: Record<string, unknown>,
) {
  const { data: existing, error } = await supabase
    .from('lead_tasks')
    .select('id')
    .eq('lead_id', leadId)
    .eq('task_type', taskType)
    .eq('task_status', 'open')
    .maybeSingle();
  if (error) throw error;
  if (existing) return existing;

  return createLeadTask(supabase, {
    leadId,
    taskType,
    ownerType: 'system',
    title: 'Repair lead response automation',
    description,
    priorityLevel: 1,
    dueAt: new Date().toISOString(),
    payloadJson,
  });
}

async function triggerAiReplay(leadId: string, correlationId: string) {
  const response = await fetch(`${env.supabaseUrl()}/functions/v1/ai-replay`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.slaWorkerSecret()}`,
      'Content-Type': 'application/json',
      'x-correlation-id': correlationId,
    },
    body: JSON.stringify({
      leadId,
      forceAi: true,
      note: 'Auto replay from ai-watchdog after stale inbound',
    }),
  }).catch((err) => {
    log.error('ai_watchdog_replay_failed', {
      fn: 'ai-watchdog',
      correlationId,
      leadId,
      err: String(err),
    });
    return null;
  });

  if (!response) return;
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    log.error('ai_watchdog_replay_failed', {
      fn: 'ai-watchdog',
      correlationId,
      leadId,
      status: response.status,
      err: errText.slice(0, 400),
    });
  } else {
    log.info('ai_watchdog_replay_triggered', {
      fn: 'ai-watchdog',
      correlationId,
      leadId,
    });
  }
}
