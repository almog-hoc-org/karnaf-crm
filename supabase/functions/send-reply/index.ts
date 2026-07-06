// Manual reply sent by Mia / sales rep from the operator console. Records
// the message, updates ownership, fires the WhatsApp send.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { sendWhatsAppText, sendWhatsAppTemplate } from '../_shared/whatsapp-provider.ts';
import { sendInstagramText } from '../_shared/instagram-provider.ts';
import { resolveSendMode } from '../_shared/conversation-window.ts';
import { logLeadEvent, transitionLeadStatus, updateLeadFields } from '../_shared/lead-service.ts';
import { canTransition } from '../_shared/state-machine.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { getRuntimeConfig } from '../_shared/config-service.ts';
import { fallbackTemplateParams, isTemplateConfigError } from '../_shared/provider-errors.ts';
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
    .select('id, phone, ig_user_id, last_inbound_at, do_not_contact, removed_by_request, ownership_mode, lead_status')
    .eq('id', leadId)
    .single();
  if (leadErr || !lead) return jsonResponse(req, { error: leadErr?.message ?? 'Lead not found' }, 404);
  if (lead.do_not_contact || lead.removed_by_request) return jsonResponse(req, { error: 'Lead suppressed' }, 409);

  // Tier 8.A — replies follow the conversation's channel.
  const { data: conv } = await supabase.from('conversations')
    .select('channel').eq('id', conversationId).maybeSingle();
  const channel: string = conv?.channel ?? 'whatsapp';
  if (channel === 'instagram') {
    if (!lead.ig_user_id) return jsonResponse(req, { error: 'Lead has no Instagram identity' }, 409);
  } else if (!lead.phone) {
    return jsonResponse(req, { error: 'Lead has no phone number' }, 409);
  }

  const mode = resolveSendMode('freeform', lead.last_inbound_at, config.whatsappSession.freeformWindowHours);
  let result;
  let pendingReplyId: string | null = null;
  try {
    if (mode === 'freeform') {
      result = channel === 'instagram'
        ? await sendInstagramText(lead.ig_user_id as string, text)
        : await sendWhatsAppText(lead.phone as string, text);
    } else if (channel === 'instagram') {
      // Instagram has no template product — outside the 24h window the
      // reply can only wait for the customer's next message. Queue it;
      // instagram-webhook flushes the queue on the next inbound.
      const { data: pending, error: pendingErr } = await supabase.from('pending_manual_replies').insert({
        lead_id: leadId,
        conversation_id: conversationId,
        text,
        sender_user_id: staff.userId,
        sender_type: staff.role === 'sales_rep' ? 'sales_rep' : 'mia',
        sender_name: staff.fullName || staff.email,
        status: 'queued',
        metadata: { correlationId, channel },
      }).select('id').single();
      if (pendingErr) throw pendingErr;
      pendingReplyId = pending?.id as string | null;

      await logLeadEvent(supabase, leadId, 'manual_reply_queued_after_24h', staff.role, {
        correlation_id: correlationId,
        pending_reply_id: pendingReplyId,
        channel: 'instagram',
        length: text.length,
      }, conversationId, staff.userId);

      return jsonResponse(req, {
        ok: true,
        mode: 'queued_no_template',
        queued: true,
        pendingReplyId,
        warning: 'חלון ה־24 שעות באינסטגרם נסגר — ההודעה תישלח אוטומטית ברגע שהלקוח יכתוב שוב.',
      });
    } else {
      const { data: pending, error: pendingErr } = await supabase.from('pending_manual_replies').insert({
        lead_id: leadId,
        conversation_id: conversationId,
        text,
        sender_user_id: staff.userId,
        sender_type: staff.role === 'sales_rep' ? 'sales_rep' : 'mia',
        sender_name: staff.fullName || staff.email,
        status: 'queued',
        reopen_template_name: config.whatsappSession.fallbackTemplateName,
        metadata: { correlationId },
      }).select('id').single();
      if (pendingErr) throw pendingErr;
      pendingReplyId = pending?.id as string | null;

      // Canonical single-param wrap — the approved template's {{1}} body
      // variable carries the reply text. Sending anything else (this used
      // to send the lead's phone under name:'name') risks #132000.
      result = await sendWhatsAppTemplate(
        lead.phone as string,
        config.whatsappSession.fallbackTemplateName,
        fallbackTemplateParams(text.slice(0, 600)),
      );
    }
  } catch (err) {
    result = { ok: false, error: String(err) };
  }

  if (!result.ok) {
    const friendly = formatManualReplyFailure(result.error ?? 'Send failed', mode, config.whatsappSession.fallbackTemplateName);
    if (pendingReplyId) {
      await supabase.from('pending_manual_replies').update({
        status: 'failed',
        last_error: result.error ?? 'Send failed',
        failed_at: new Date().toISOString(),
      }).eq('id', pendingReplyId);
    }
    await ensurePendingQueueItem(supabase, {
      leadId, queueType: 'failed_automation', priorityLevel: 1,
      reason: friendly.queueReason,
      queueSummary: friendly.userMessage,
      payloadJson: { error: result.error ?? null, mode, pendingReplyId, templateName: config.whatsappSession.fallbackTemplateName, correlationId },
      createdByActorType: staff.role,
    });
    if (pendingReplyId && friendly.code === 'WHATSAPP_TEMPLATE_MISSING') {
      await logLeadEvent(supabase, leadId, 'manual_reply_queued_template_missing', staff.role, {
        correlation_id: correlationId,
        pending_reply_id: pendingReplyId,
        template_name: config.whatsappSession.fallbackTemplateName,
        length: text.length,
      }, conversationId, staff.userId);
      return jsonResponse(req, {
        ok: true,
        mode: 'queued_no_template',
        queued: true,
        pendingReplyId,
        warning: friendly.userMessage,
      });
    }
    return jsonResponse(req, {
      ok: false,
      error: friendly.userMessage,
      code: friendly.code,
      providerError: result.error ?? null,
      mode,
    }, friendly.status);
  }

  if (mode === 'template' && pendingReplyId) {
    await supabase.from('pending_manual_replies').update({
      status: 'reopen_sent',
      reopen_provider_message_id: result.providerMessageId ?? null,
      reopen_sent_at: new Date().toISOString(),
    }).eq('id', pendingReplyId);

    await updateLeadFields(supabase, leadId, {
      ownership_mode: lead.ownership_mode === 'ai_active' ? 'mia_active' : lead.ownership_mode,
      human_owner_id: staff.userId,
      last_human_touch_at: new Date().toISOString(),
    });
    if (lead.ownership_mode === 'ai_active' && canTransition(String(lead.lead_status), 'human_handoff')) {
      await transitionLeadStatus(supabase, leadId, 'human_handoff', staff.role, 'manual_reply_takeover');
    }

    await logLeadEvent(supabase, leadId, 'manual_reply_queued_after_24h', staff.role, {
      correlation_id: correlationId,
      pending_reply_id: pendingReplyId,
      template_name: config.whatsappSession.fallbackTemplateName,
      template_provider_message_id: result.providerMessageId ?? null,
      length: text.length,
    }, conversationId, staff.userId);

    log.info('manual_reply_queued_after_24h', { fn: 'send-reply', correlationId, leadId, userId: staff.userId, pendingReplyId });
    return jsonResponse(req, { ok: true, mode: 'queued_template', queued: true, pendingReplyId });
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

function formatManualReplyFailure(error: string, mode: string, templateName: string) {
  // #132001 (template missing) and #132000 (approved variable count
  // doesn't match what we send) are both configuration problems in Meta —
  // retrying won't help. Queue the reply for the next inbound instead of
  // hard-failing the operator.
  const templateBroken = mode === 'template' && isTemplateConfigError(error);

  if (templateBroken) {
    return {
      status: 409,
      code: 'WHATSAPP_TEMPLATE_MISSING',
      queueReason: 'Manual reply failed; WhatsApp fallback template is missing or misconfigured',
      userMessage:
        `אי אפשר לשלוח הודעה חופשית כי חלון ה־24 שעות בוואטסאפ נסגר, ` +
        `והתבנית המאושרת "${templateName}" חסרה או לא תואמת ב־Meta (מספר משתנים שגוי). ` +
        `ההודעה נשמרה ותישלח כשהלקוח יכתוב שוב; לתיקון קבוע יש לעדכן את התבנית ב־Meta.`,
    };
  }

  return {
    status: 502,
    code: 'WHATSAPP_SEND_FAILED',
    queueReason: 'Manual reply failed; provider error',
    userMessage: `שליחת ההודעה נכשלה מול WhatsApp. ${summarizeProviderError(error)}`,
  };
}

function summarizeProviderError(error: string): string {
  try {
    const parsed = JSON.parse(error) as { error?: { message?: string; error_data?: { details?: string } } };
    return parsed.error?.error_data?.details ?? parsed.error?.message ?? 'נסו שוב או בדקו את הגדרות הספק.';
  } catch {
    return error.slice(0, 220);
  }
}
