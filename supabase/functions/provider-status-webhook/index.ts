import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { verifyMetaSignature } from '../_shared/webhook-signature.ts';
import { env, optional } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { checkRateLimit, clientIdentifier } from '../_shared/rate-limit.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  const rawBody = await req.text();

  // Fail-closed: WHATSAPP_APP_SECRET must be set AND the signature header
  // must be present. Previously the check was skipped silently if either
  // was missing — an attacker omitting the header could bypass entirely.
  // WEBHOOK_ALLOW_UNSIGNED=true is the explicit dev-only opt-out.
  const appSecret = env.whatsappAppSecret();
  if (!appSecret) {
    if (optional('WEBHOOK_ALLOW_UNSIGNED') !== 'true') {
      log.error('status_webhook_misconfigured', { fn: 'provider-status-webhook', correlationId });
      return jsonResponse(req, { error: 'Webhook not configured' }, 503);
    }
  } else {
    if (!req.headers.get('x-hub-signature-256')) {
      log.warn('status_signature_missing', { fn: 'provider-status-webhook', correlationId });
      return jsonResponse(req, { error: 'Missing signature header' }, 401);
    }
    const valid = await verifyMetaSignature(req, rawBody, appSecret);
    if (!valid) {
      log.warn('status_signature_invalid', { fn: 'provider-status-webhook', correlationId });
      return jsonResponse(req, { error: 'Invalid signature' }, 401);
    }
  }

  let payload: Record<string, unknown>;
  try { payload = JSON.parse(rawBody); } catch {
    return jsonResponse(req, { error: 'Invalid JSON' }, 400);
  }

  const supabase = getServiceSupabase();

  const allowed = await checkRateLimit(supabase, {
    key: `status:${clientIdentifier(req)}`,
    windowSeconds: 60,
    maxRequests: 240,
  });
  if (!allowed) {
    return jsonResponse(req, { error: 'Rate limit exceeded' }, 429);
  }

  // Meta delivers an array of statuses inside entry[0].changes[0].value.statuses;
  // WATI sends flat fields. Normalise both shapes.
  const flatStatuses = Array.isArray(payload.statuses) ? (payload.statuses as Array<Record<string, unknown>>) : null;
  const metaStatuses = (((payload.entry as Array<Record<string, unknown>> | undefined)?.[0]?.changes as Array<Record<string, unknown>> | undefined)?.[0]?.value as Record<string, unknown> | undefined)?.statuses as Array<Record<string, unknown>> | undefined;
  const statuses = metaStatuses ?? flatStatuses ?? [{
    id: payload.message_id ?? payload.id,
    status: payload.status,
    errors: payload.error ? [payload.error] : payload.errors,
  }];

  let processed = 0;
  for (const item of statuses) {
    const providerMessageId = (item.id ?? item.message_id) as string | undefined;
    const status = String(item.status ?? 'unknown').toLowerCase();
    const errorMessage = ((item.errors as Array<Record<string, unknown>> | undefined)?.[0]?.message
      ?? (item.error as Record<string, unknown> | undefined)?.message
      ?? null) as string | null;

    if (!providerMessageId) continue;

    const { data: message } = await supabase
      .from('messages')
      .select('id, lead_id, conversation_id')
      .eq('provider_message_id', providerMessageId)
      .maybeSingle();
    if (!message) continue;

    const updates: Record<string, unknown> = { provider_status: status };
    const ts = new Date().toISOString();
    if (status === 'delivered') updates.delivered_at = ts;
    if (status === 'read') updates.read_at = ts;
    if (status === 'failed') updates.provider_error = errorMessage;

    await supabase.from('messages').update(updates).eq('id', message.id);
    await supabase.from('lead_events').insert({
      lead_id: message.lead_id,
      conversation_id: message.conversation_id,
      event_type: 'provider_message_status_updated',
      actor_type: 'provider',
      event_payload: { provider_message_id: providerMessageId, status, error_message: errorMessage, correlation_id: correlationId },
    });
    processed++;
  }

  return jsonResponse(req, { ok: true, processed });
});
