import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { verifyMetaSignature } from '../_shared/webhook-signature.ts';
import { env, optional } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { checkRateLimit, clientIdentifier } from '../_shared/rate-limit.ts';
import { applyProviderStatuses, extractProviderStatuses } from '../_shared/provider-status.ts';

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

  // Parsing and application are shared with whatsapp-webhook, which is
  // where Meta actually delivers receipts (one callback URL per app).
  const statuses = extractProviderStatuses(payload);
  const applied = await applyProviderStatuses(supabase, statuses, correlationId);
  const processed = applied.matched;

  return jsonResponse(req, { ok: true, processed });
});
