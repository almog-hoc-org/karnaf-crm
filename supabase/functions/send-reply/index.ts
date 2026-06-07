// Manual reply sent by Mia / sales rep from the operator console. Records
// the message, updates ownership, fires the WhatsApp send.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { sendWhatsAppText, sendWhatsAppTemplate } from '../_shared/whatsapp-provider.ts';
import { resolveSendMode } from '../_shared/conversation-window.ts';
import { logLeadEvent, transitionLeadStatus, updateLeadFields } from '../_shared/lead-service.ts';
import { canTransition } from '../_shared/state-machine.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { getRuntimeConfig } from '../_shared/config-service.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

interface ReplyPayload {
  leadId: string;
  conversationId: string;
  text: string;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  let staff;
  try {
    staff = await requireStaff(req, { allow: ['owner', 'admin', 'mia', 'sales_rep'] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const body = await req.json().catch(() => ({})) as Partial<ReplyPayload>;
  const { leadId, conversationId, text } = body;
  if (!leadId || !conversationId || !text || typeof text !== 'string') {
    return jsonResponse(req, { error: 'Missing leadId, conversationId or text' }, 400);
  }
  if (text.length > 2000) return jsonResponse(req, { error: 'Reply too long' }, 400);

  const supabase = getServiceSupabase();
  const config = await getRuntimeConfig(supabase);

  const { data: lead, error: leadErr } = await supabase.from('leads')
    .select('id, phone, last_inbound_at, do_not_contact, removed_by_request, ownership_mode, lead_status')
    .eq('id', leadId)
    .single();
  if (leadErr || !lead) return jsonResponse(req, { error: leadErr?.message ?? 'Lead not found' }, 404);
  if (lead.do_not_contact || lead.removed_by_request) return jsonResponse(req, { error: 'Lead suppressed' }, 409);
  if (!lead.phone) return jsonResponse(req, { error: 'Lead has no phone number' }, 409);

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
      leadId, queueType: 'failed_automation', priorityLevel: 1,
      reason: 'Manual reply failed; provider error',
      payloadJson: { error: result.error ?? null, correlationId },
      createdByActorType: staff.role,
    });
    return jsonResponse(req, { ok: false, error: result.error ?? 'Send failed' }, 502);
  }

  await supabase.from('messages').insert({
    conversation_id: conversationId,
    lead_id: leadId,
    provider_message_id: result.providerMessageId ?? null,
    sender_type: staff.role === 'sales_rep' ? 'sales_rep' : 'mia',
    sender_name: staff.fullName || staff.email,
    direction: 'outbound',
    message_type: mode === 'template' ? 'template' : 'text',
    content_text: text,
    provider_status: 'sent',
  });

  await updateLeadFields(supabase, leadId, {
    ownership_mode: lead.ownership_mode === 'ai_active' ? 'mia_active' : lead.ownership_mode,
    human_owner_id: staff.userId,
    last_human_touch_at: new Date().toISOString(),
  });
  if (lead.ownership_mode === 'ai_active' && canTransition(String(lead.lead_status), 'human_handoff')) {
    await transitionLeadStatus(supabase, leadId, 'human_handoff', staff.role, 'manual_reply_takeover');
  }

  await logLeadEvent(supabase, leadId, 'human_reply_sent', staff.role, {
    correlation_id: correlationId, mode, length: text.length,
  }, conversationId, staff.userId);

  log.info('manual_reply_sent', { fn: 'send-reply', correlationId, leadId, userId: staff.userId, mode });
  return jsonResponse(req, { ok: true, mode });
});
