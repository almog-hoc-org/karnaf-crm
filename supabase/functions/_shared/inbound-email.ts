// One path for an inbound email into the CRM: find (or create) the lead,
// record the message, detect a removal request, queue it for the owner.
//
// Used by email-webhook (a provider pushes a normalised JSON) and by
// email-replies-poll (replies to campaigns, collected from Resend).
//
// The removal check runs on what the person WROTE, not on the whole body:
// a reply carries the campaign quoted underneath, and detectOptOut only
// fires on short messages — so before extractReplyText a reply of "הסר"
// was never recognised.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { ensureConversation, logLeadEvent, upsertLead } from './lead-service.ts';
import { ensurePendingQueueItem } from './queue-service.ts';
import { normalizeIsraeliPhone } from './phone.ts';
import { getRuntimeConfig } from './config-service.ts';
import { applyOptOut, detectOptOut } from './opt-out.ts';
import { extractReplyText } from './email-reply.ts';
import { log } from './logger.ts';

export interface InboundEmailInput {
  from: string;
  fromName?: string | null;
  to?: unknown;
  subject?: string | null;
  text?: string | null;
  phone?: string | null;
  messageId?: string | null;
  correlationId: string;
  /** Raw provider payload, stored on the message for debugging. */
  raw?: unknown;
  /**
   * Replies to a campaign must not create leads: a new lead is opted in by
   * default (migration 128), and an unknown sender — a colleague, an
   * auto-responder — never asked for mail. Default true (email-webhook's
   * historic behaviour).
   */
  createLeadIfMissing?: boolean;
  /** 'email_reply' when it came back from a campaign. */
  origin?: 'email_webhook' | 'email_reply';
}

export interface InboundEmailResult {
  status: 'accepted' | 'duplicate' | 'unknown_sender' | 'empty';
  leadId?: string;
  leadName?: string | null;
  conversationId?: string;
  optOut: boolean;
  /** What the person wrote, without the quoted original. */
  replyText: string;
}

export async function ingestInboundEmail(
  supabase: SupabaseClient,
  input: InboundEmailInput,
): Promise<InboundEmailResult> {
  const fromEmail = input.from.trim().toLowerCase();
  const subject = (input.subject ?? '').trim();
  const textBody = (input.text ?? '').trim();
  const replyText = extractReplyText(textBody);
  const messageId = input.messageId ?? null;
  const createLead = input.createLeadIfMissing !== false;

  if (!textBody && !subject) return { status: 'empty', optOut: false, replyText };

  if (messageId) {
    const { data: dup } = await supabase
      .from('messages').select('id').eq('provider_message_id', messageId).maybeSingle();
    if (dup) return { status: 'duplicate', optOut: false, replyText };
  }

  let lead: { id: string; full_name?: string | null };
  if (createLead) {
    lead = await upsertLead(supabase, {
      phone: normalizeIsraeliPhone(input.phone ?? null),
      email: fromEmail,
      fullName: input.fromName ?? null,
      source: 'email',
      intakeChannel: 'email',
      metadata: { to: input.to ?? null, message_id: messageId, subject },
    });
  } else {
    const { data: existing } = await supabase
      .from('leads').select('id, full_name')
      .ilike('email', fromEmail.replace(/[\\%_]/g, (c) => `\\${c}`))
      .limit(1).maybeSingle();
    if (!existing) return { status: 'unknown_sender', optOut: false, replyText };
    lead = existing as { id: string; full_name: string | null };
  }

  const conversation = await ensureConversation(supabase, lead.id, 'email', 'email_provider');
  const composed = subject ? `נושא: ${subject}\n\n${replyText || textBody}` : (replyText || textBody);

  const { error: insertErr } = await supabase.from('messages').insert({
    conversation_id: conversation.id,
    lead_id: lead.id,
    provider_message_id: messageId,
    sender_type: 'lead',
    sender_name: input.fromName ?? null,
    direction: 'inbound',
    message_type: 'text',
    content_text: composed,
    raw_payload: input.raw ?? null,
  });
  if (insertErr && !String(insertErr.message || '').includes('duplicate key value')) {
    throw new Error(`inbound email insert failed: ${insertErr.message}`);
  }

  await logLeadEvent(supabase, lead.id, 'email_inbound_received', 'provider', {
    correlation_id: input.correlationId, subject, message_id: messageId, origin: input.origin ?? 'email_webhook',
  }, conversation.id);

  // חוק הספאם: a removal request revokes email consent right away. The
  // subject alone can carry it ("הסר"), or the first lines of the reply.
  const { messaging } = await getRuntimeConfig(supabase);
  const optOut = detectOptOut(replyText, messaging.optOutKeywords)
    || detectOptOut(subject.replace(/^(re|השב|תשובה|fw|fwd)\s*:\s*/i, ''), messaging.optOutKeywords);
  if (optOut) {
    await applyOptOut(supabase, {
      leadId: lead.id, channel: 'email', basis: 'inbound_keyword', scope: 'email',
      text: replyText || subject, correlationId: input.correlationId, conversationId: conversation.id,
    });
  }

  await ensurePendingQueueItem(supabase, {
    leadId: lead.id,
    queueType: 'human_handoff',
    priorityLevel: 2,
    reason: optOut ? 'בקשת הסרה מדיוור במייל — ההסכמה בוטלה אוטומטית' : 'אימייל נכנס דורש מענה ידני',
    queueSummary: (replyText || subject || textBody).slice(0, 120),
    payloadJson: { channel: 'email', correlationId: input.correlationId, optOut, origin: input.origin ?? 'email_webhook' },
  });

  log.info('email_inbound_accepted', {
    fn: 'inbound-email', correlationId: input.correlationId, leadId: lead.id, optOut, origin: input.origin,
  });
  return {
    status: 'accepted', leadId: lead.id, leadName: lead.full_name ?? input.fromName ?? null,
    conversationId: conversation.id, optOut, replyText,
  };
}
