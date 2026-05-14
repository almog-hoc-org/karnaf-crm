import { jsonResponse, preflight } from '../_shared/cors.ts';
import { normalizeIsraeliPhone } from '../_shared/phone.ts';
import { normalizeProviderInbound } from '../_shared/whatsapp-provider.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensureConversation, logLeadEvent, upsertLeadByPhone } from '../_shared/lead-service.ts';
import { messageAlreadyLogged } from '../_shared/idempotency.ts';
import { verifyMetaSignature } from '../_shared/webhook-signature.ts';
import { env, optional, safeEqual } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { checkRateLimit, clientIdentifier } from '../_shared/rate-limit.ts';
import { archiveWhatsAppMedia } from '../_shared/media-fetch.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const correlationId = correlationFromRequest(req);

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token && safeEqual(token, env.whatsappVerifyToken())) {
      return new Response(challenge ?? '', { status: 200 });
    }
    return jsonResponse(req, { error: 'Forbidden' }, 403);
  }

  if (req.method !== 'POST') {
    return jsonResponse(req, { error: 'Method not allowed' }, 405);
  }

  const rawBody = await req.text();

  // Fail-closed: WHATSAPP_APP_SECRET must be set in production. Previously
  // an unset secret silently accepted unsigned bodies — anyone with the URL
  // could inject inbound messages. WEBHOOK_ALLOW_UNSIGNED=true is the
  // explicit dev-only opt-out.
  const metaSecret = env.whatsappAppSecret();
  if (!metaSecret) {
    if (optional('WEBHOOK_ALLOW_UNSIGNED') !== 'true') {
      log.error('whatsapp_webhook_misconfigured', { fn: 'whatsapp-webhook', correlationId });
      return jsonResponse(req, { error: 'Webhook not configured' }, 503);
    }
  } else {
    const sigHeader = req.headers.get('x-hub-signature-256');
    if (!sigHeader) {
      log.warn('whatsapp_signature_missing', { fn: 'whatsapp-webhook', correlationId });
      return jsonResponse(req, { error: 'Missing signature' }, 401);
    }
    const valid = await verifyMetaSignature(req, rawBody, metaSecret);
    if (!valid) {
      log.warn('whatsapp_signature_invalid', { fn: 'whatsapp-webhook', correlationId });
      return jsonResponse(req, { error: 'Invalid signature' }, 401);
    }
  }

  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody); } catch {
    return jsonResponse(req, { error: 'Invalid JSON' }, 400);
  }

  const normalized = normalizeProviderInbound(body);
  if (!normalized) {
    return jsonResponse(req, { ok: true, skipped: true, reason: 'unsupported_payload' });
  }

  const supabase = getServiceSupabase();

  const allowed = await checkRateLimit(supabase, {
    key: `whatsapp:${clientIdentifier(req)}`,
    windowSeconds: 60,
    maxRequests: 120,
  });
  if (!allowed) {
    log.warn('rate_limited', { fn: 'whatsapp-webhook', correlationId, ip: clientIdentifier(req) });
    return jsonResponse(req, { error: 'Rate limit exceeded' }, 429);
  }

  if (await messageAlreadyLogged(supabase, normalized.providerMessageId)) {
    return jsonResponse(req, { ok: true, skipped: true, reason: 'duplicate_provider_message_id' });
  }

  const phone = normalizeIsraeliPhone(normalized.phone) || normalized.phone;
  const lead = await upsertLeadByPhone(supabase, {
    phone,
    senderName: normalized.senderName,
    source: 'whatsapp',
    intakeChannel: 'whatsapp',
  });
  const conversation = await ensureConversation(supabase, lead.id, 'whatsapp', normalized.provider);

  // Insert the inbound message; relies on trigger sync_lead_message_timestamps
  // to update lead.last_message_at + last_inbound_at atomically.
  const { data: insertedMsg, error: msgErr } = await supabase.from('messages').insert({
    conversation_id: conversation.id,
    lead_id: lead.id,
    provider_message_id: normalized.providerMessageId,
    sender_type: 'lead',
    sender_name: normalized.senderName,
    direction: 'inbound',
    message_type: normalized.messageType === 'unknown' ? 'text' : normalized.messageType,
    content_text: normalized.text,
    media_type: normalized.mediaType ?? null,
    created_at: normalized.receivedAt,
    raw_payload: normalized.rawPayload,
  }).select('id').single();
  // Conflict on the unique provider_message_id index = duplicate that beat
  // our pre-check. Treat as no-op success.
  if (msgErr && !String(msgErr.message || '').includes('duplicate key value')) {
    log.error('inbound_insert_failed', { fn: 'whatsapp-webhook', correlationId, err: String(msgErr) });
    return jsonResponse(req, { error: 'Failed to log inbound message' }, 500);
  }

  // Archive WhatsApp media (image/audio/video/document) to private storage
  // out-of-band. Failures are logged but never break the webhook contract.
  if (insertedMsg?.id && normalized.messageType === 'media') {
    archiveWhatsAppMedia(supabase, {
      messageId: insertedMsg.id as string,
      providerMessageId: normalized.providerMessageId,
      rawPayload: normalized.rawPayload,
      conversationId: conversation.id,
    }, correlationId).catch((err) =>
      log.error('media_archive_failed', { fn: 'whatsapp-webhook', correlationId, err: String(err) }),
    );
  }

  await logLeadEvent(supabase, lead.id, 'inbound_message_received', 'provider', {
    provider: normalized.provider,
    provider_message_id: normalized.providerMessageId,
    correlation_id: correlationId,
  }, conversation.id);

  // Fire-and-forget the orchestrator. We don't await its work to keep the
  // webhook latency low; the Supabase edge runtime guarantees the request
  // completes before the function shuts down.
  const orchestrateUrl = `${env.supabaseUrl()}/functions/v1/orchestrate-message`;
  fetch(orchestrateUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.serviceRoleKey()}`,
      'Content-Type': 'application/json',
      'x-correlation-id': correlationId,
    },
    body: JSON.stringify({ leadId: lead.id, conversationId: conversation.id }),
  }).catch((err) => log.error('orchestrate_dispatch_failed', { fn: 'whatsapp-webhook', correlationId, err: String(err) }));

  log.info('inbound_accepted', { fn: 'whatsapp-webhook', correlationId, leadId: lead.id, conversationId: conversation.id });
  return jsonResponse(req, { ok: true, leadId: lead.id, conversationId: conversation.id, correlationId });
});
