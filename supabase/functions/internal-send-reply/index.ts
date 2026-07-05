import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { sendWhatsAppTemplate, sendWhatsAppText } from '../_shared/whatsapp-provider.ts';
import { resolveSendMode } from '../_shared/conversation-window.ts';
import { getRuntimeConfig } from '../_shared/config-service.ts';
import { logLeadEvent, updateLeadFields } from '../_shared/lead-service.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { env } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { validateOutboundText } from '../_shared/outbound-safety.ts';

interface Payload {
  leadId?: string;
  conversationId?: string;
  text?: string;
  senderType?: 'mia' | 'sales_rep' | 'system';
  updateOwnershipMode?: string;
  note?: string;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  const expected = env.slaWorkerSecret();
  if (!expected) return jsonResponse(req, { error: 'Internal send secret not configured' }, 500);
  if (!verifyBearer(req, expected)) return jsonResponse(req, { error: 'Unauthorized' }, 401);

  const body = await req.json().catch(() => ({})) as Payload;
  const { leadId, conversationId, text } = body;
  if (!leadId || !conversationId || !text || typeof text !== 'string') {
    return jsonResponse(req, { error: 'Missing leadId, conversationId or text' }, 400);
  }
  if (text.length > 2000) return jsonResponse(req, { error: 'Reply too long' }, 400);

  const supabase = getServiceSupabase();
  const safety = validateOutboundText(text);
  if (!safety.ok) {
    await ensurePendingQueueItem(supabase, {
      leadId,
      queueType: 'failed_automation',
      priorityLevel: 1,
      reason: 'Internal reply blocked by outbound safety policy',
      payloadJson: { reason: safety.reason, correlationId },
      createdByActorType: 'system',
    });
    return jsonResponse(req, { error: 'Reply blocked by outbound safety policy', reason: safety.reason }, 400);
  }
  const config = await getRuntimeConfig(supabase);

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('id, phone, last_inbound_at, do_not_contact, removed_by_request')
    .eq('id', leadId)
    .single();
  if (leadErr || !lead) return jsonResponse(req, { error: leadErr?.message ?? 'Lead not found' }, 404);
  if (lead.do_not_contact || lead.removed_by_request) return jsonResponse(req, { error: 'Lead suppressed' }, 409);

  const mode = resolveSendMode('freeform', lead.last_inbound_at, config.whatsappSession.freeformWindowHours);
  let result;
  try {
    if (mode === 'freeform') {
      result = await sendWhatsAppText(lead.phone as string, text);
    } else {
      result = await sendWhatsAppTemplate(lead.phone as string, config.whatsappSession.fallbackTemplateName, [
        { name: 'reply', value: text },
      ]);
    }
  } catch (err) {
    result = { ok: false, error: String(err) };
  }

  if (!result.ok) {
    await ensurePendingQueueItem(supabase, {
      leadId,
      queueType: 'failed_automation',
      priorityLevel: 1,
      reason: 'Internal reply failed; provider error',
      payloadJson: { error: result.error ?? null, correlationId },
      createdByActorType: 'system',
    });
    return jsonResponse(req, { ok: false, error: result.error ?? 'Send failed' }, 502);
  }

  const senderType = body.senderType ?? 'mia';
  await supabase.from('messages').insert({
    conversation_id: conversationId,
    lead_id: leadId,
    provider_message_id: result.providerMessageId ?? null,
    sender_type: senderType,
    sender_name: senderType === 'system' ? 'Karnaf CRM' : 'נציג',
    direction: 'outbound',
    message_type: mode === 'template' ? 'template' : 'text',
    content_text: text,
    provider_status: 'sent',
  });

  const updates: Record<string, unknown> = {
    last_human_touch_at: new Date().toISOString(),
  };
  if (body.updateOwnershipMode) updates.ownership_mode = body.updateOwnershipMode;
  await updateLeadFields(supabase, leadId, updates);

  await logLeadEvent(supabase, leadId, 'internal_reply_sent', 'system', {
    correlation_id: correlationId,
    mode,
    sender_type: senderType,
    note: body.note ?? null,
  }, conversationId);

  log.info('internal_reply_sent', { fn: 'internal-send-reply', correlationId, leadId, mode });
  return jsonResponse(req, { ok: true, mode, correlationId });
});
