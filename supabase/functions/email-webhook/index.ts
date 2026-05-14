// Inbound email ingestion. Accepts a normalised JSON shape that any of the
// big email-provider webhooks (Mailgun parsed-message, Postmark inbound,
// SendGrid inbound parse) can be coerced into upstream:
//   {
//     "from":      "lead@example.com",
//     "from_name": "Israel Israeli",            // optional
//     "to":        "crm@karnaf.io",             // optional
//     "subject":   "שאלה על התוכנית",            // optional
//     "text":      "תוכן המייל בטקסט נקי",
//     "message_id":"<provider-message-id>",     // optional but unique-ish
//     "phone":     "+972501234567"              // optional
//   }
// HMAC verified against EMAIL_WEBHOOK_SECRET when set.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensureConversation, logLeadEvent, upsertLead } from '../_shared/lead-service.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { normalizeIsraeliPhone } from '../_shared/phone.ts';
import { verifyHmacHeader } from '../_shared/webhook-signature.ts';
import { optional } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { checkRateLimit, clientIdentifier } from '../_shared/rate-limit.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  const rawBody = await req.text();
  // Fail-closed: production must have EMAIL_WEBHOOK_SECRET set. A missing
  // secret used to skip verification entirely (fail-open). Set
  // WEBHOOK_ALLOW_UNSIGNED=true only in local dev to bypass.
  const secret = optional('EMAIL_WEBHOOK_SECRET');
  if (!secret) {
    if (optional('WEBHOOK_ALLOW_UNSIGNED') !== 'true') {
      log.error('email_webhook_misconfigured', { fn: 'email-webhook', correlationId });
      return jsonResponse(req, { error: 'Webhook not configured' }, 503);
    }
  } else {
    const valid = await verifyHmacHeader(req, rawBody, secret, 'x-karnaf-signature');
    if (!valid) {
      log.warn('email_signature_invalid', { fn: 'email-webhook', correlationId });
      return jsonResponse(req, { error: 'Invalid signature' }, 401);
    }
  }

  let payload: Record<string, unknown>;
  try { payload = JSON.parse(rawBody); } catch {
    return jsonResponse(req, { error: 'Invalid JSON' }, 400);
  }

  const supabase = getServiceSupabase();
  const allowed = await checkRateLimit(supabase, {
    key: `email:${clientIdentifier(req)}`,
    windowSeconds: 60,
    maxRequests: 60,
  });
  if (!allowed) return jsonResponse(req, { error: 'Rate limit exceeded' }, 429);

  const fromEmail = typeof payload.from === 'string' ? payload.from.trim().toLowerCase() : null;
  const fromName = typeof payload.from_name === 'string' ? payload.from_name.trim() : null;
  const subject = typeof payload.subject === 'string' ? payload.subject.trim() : '';
  const textBody = typeof payload.text === 'string' ? payload.text.trim() : '';
  const phoneRaw = typeof payload.phone === 'string' ? payload.phone : null;
  const phone = normalizeIsraeliPhone(phoneRaw);
  const messageId = typeof payload.message_id === 'string' ? payload.message_id : null;

  if (!fromEmail) {
    return jsonResponse(req, { error: 'Missing from address' }, 400);
  }
  if (!textBody && !subject) {
    return jsonResponse(req, { error: 'Empty email body and subject' }, 400);
  }

  // Idempotency on the provider's Message-Id when supplied.
  if (messageId) {
    const { data: dup } = await supabase
      .from('messages')
      .select('id')
      .eq('provider_message_id', messageId)
      .maybeSingle();
    if (dup) return jsonResponse(req, { ok: true, duplicate: true });
  }

  const lead = await upsertLead(supabase, {
    phone,
    email: fromEmail,
    fullName: fromName,
    source: 'email',
    intakeChannel: 'email',
    metadata: {
      to: payload.to ?? null,
      message_id: messageId,
      subject,
    },
  });

  const conversation = await ensureConversation(supabase, lead.id, 'email', 'email_provider');
  const composed = subject ? `נושא: ${subject}\n\n${textBody}` : textBody;

  const { error: insertErr } = await supabase.from('messages').insert({
    conversation_id: conversation.id,
    lead_id: lead.id,
    provider_message_id: messageId,
    sender_type: 'lead',
    sender_name: fromName,
    direction: 'inbound',
    message_type: 'text',
    content_text: composed,
    raw_payload: payload,
  });
  if (insertErr && !String(insertErr.message || '').includes('duplicate key value')) {
    log.error('email_insert_failed', { fn: 'email-webhook', correlationId, err: insertErr.message });
    return jsonResponse(req, { error: 'Failed to log inbound email' }, 500);
  }

  await logLeadEvent(supabase, lead.id, 'email_inbound_received', 'provider', {
    correlation_id: correlationId, subject, message_id: messageId,
  }, conversation.id);

  // Email replies need a human; the WhatsApp orchestrator can't compose
  // outbound email yet, so we always queue Mia for the first turn.
  await ensurePendingQueueItem(supabase, {
    leadId: lead.id,
    queueType: 'human_handoff',
    priorityLevel: 2,
    reason: 'אימייל נכנס דורש מענה ידני',
    queueSummary: subject || textBody.slice(0, 120),
    payloadJson: { channel: 'email', correlationId },
  });

  log.info('email_inbound_accepted', {
    fn: 'email-webhook', correlationId, leadId: lead.id, conversationId: conversation.id,
  });
  return jsonResponse(req, { ok: true, leadId: lead.id, conversationId: conversation.id, correlationId });
});
