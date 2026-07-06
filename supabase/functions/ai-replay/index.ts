import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { logLeadEvent, updateLeadFields } from '../_shared/lead-service.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { env } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

interface ReplayPayload {
  leadId?: string;
  conversationId?: string;
  forceAi?: boolean;
  forceEvenIfAnswered?: boolean;
  note?: string;
}

const MEANINGFUL_OUTBOUND_SENDERS = ['ai', 'human', 'mia', 'staff', 'operator', 'admin', 'sales'];

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  const expected = env.slaWorkerSecret();
  if (!expected) return jsonResponse(req, { error: 'Replay secret not configured' }, 500);
  if (!verifyBearer(req, expected)) return jsonResponse(req, { error: 'Unauthorized' }, 401);

  const body = await req.json().catch(() => ({})) as ReplayPayload;
  if (!body.leadId) return jsonResponse(req, { error: 'Missing leadId' }, 400);

  const supabase = getServiceSupabase();
  let conversationId = body.conversationId ?? null;
  if (!conversationId) {
    const { data, error } = await supabase
      .from('conversations')
      .select('id')
      .eq('lead_id', body.leadId)
      .eq('channel', 'whatsapp')
      .order('last_activity_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return jsonResponse(req, { error: error.message }, 500);
    conversationId = data?.id ?? null;
  }
  if (!conversationId) return jsonResponse(req, { error: 'No WhatsApp conversation found' }, 404);

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('last_inbound_at')
    .eq('id', body.leadId)
    .maybeSingle();
  if (leadErr) return jsonResponse(req, { error: leadErr.message }, 500);

  if (lead?.last_inbound_at && !body.forceEvenIfAnswered) {
    const { data: meaningfulOutbound, error: meaningfulErr } = await supabase
      .from('messages')
      .select('id, created_at, sender_type')
      .eq('lead_id', body.leadId)
      .eq('direction', 'outbound')
      .in('sender_type', MEANINGFUL_OUTBOUND_SENDERS)
      .gt('created_at', lead.last_inbound_at)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (meaningfulErr) return jsonResponse(req, { error: meaningfulErr.message }, 500);
    if (meaningfulOutbound) {
      return jsonResponse(req, {
        ok: true,
        skipped: 'already_answered',
        lastMeaningfulOutboundAt: meaningfulOutbound.created_at,
        senderType: meaningfulOutbound.sender_type,
        correlationId,
      });
    }
  }

  if (body.forceAi) {
    await updateLeadFields(supabase, body.leadId, {
      ownership_mode: 'ai_active',
      lead_status: 'responded',
      requested_phone_call: false,
      next_action_type: 'ai_replay',
      next_action_due_at: new Date().toISOString(),
    });
    await supabase
      .from('conversations')
      .update({ ownership_mode: 'ai_active' })
      .eq('id', conversationId);
    await logLeadEvent(supabase, body.leadId, 'manual_return_to_ai', 'system', {
      correlation_id: correlationId,
      note: body.note ?? 'Internal AI replay',
    }, conversationId);
  }

  const orchestrateUrl = `${env.supabaseUrl()}/functions/v1/orchestrate-message`;
  const response = await fetch(orchestrateUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.serviceRoleKey()}`,
      'Content-Type': 'application/json',
      'x-correlation-id': correlationId,
    },
    body: JSON.stringify({ leadId: body.leadId, conversationId }),
  });
  const resultText = await response.text();
  let result: unknown = resultText;
  try {
    result = JSON.parse(resultText);
  } catch {
    // Keep raw text.
  }

  log.info('ai_replay_completed', {
    fn: 'ai-replay',
    correlationId,
    leadId: body.leadId,
    conversationId,
    status: response.status,
  });
  return jsonResponse(req, { ok: response.ok, status: response.status, result, correlationId }, response.ok ? 200 : 502);
});
