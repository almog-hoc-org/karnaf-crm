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
import { verifyHmacHeader } from '../_shared/webhook-signature.ts';
import { ingestInboundEmail } from '../_shared/inbound-email.ts';
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
  if (!fromEmail) {
    return jsonResponse(req, { error: 'Missing from address' }, 400);
  }

  // Shared with email-replies-poll: same lead matching, message record,
  // removal detection on the reply text (not the quoted original), queue.
  const result = await ingestInboundEmail(supabase, {
    from: fromEmail,
    fromName: typeof payload.from_name === 'string' ? payload.from_name.trim() : null,
    to: payload.to ?? null,
    subject: typeof payload.subject === 'string' ? payload.subject : '',
    text: typeof payload.text === 'string' ? payload.text : '',
    phone: typeof payload.phone === 'string' ? payload.phone : null,
    messageId: typeof payload.message_id === 'string' ? payload.message_id : null,
    correlationId,
    raw: payload,
    origin: 'email_webhook',
  });
  if (result.status === 'empty') {
    return jsonResponse(req, { error: 'Empty email body and subject' }, 400);
  }
  if (result.status === 'duplicate') return jsonResponse(req, { ok: true, duplicate: true });
  return jsonResponse(req, {
    ok: true, leadId: result.leadId, conversationId: result.conversationId, optOut: result.optOut, correlationId,
  });
});
