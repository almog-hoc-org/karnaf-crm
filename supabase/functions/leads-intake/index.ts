import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { logLeadEvent, upsertLead } from '../_shared/lead-service.ts';
import { normalizeIsraeliPhone } from '../_shared/phone.ts';
import { verifyHmacHeader } from '../_shared/webhook-signature.ts';
import { env, optional } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { getRuntimeConfig } from '../_shared/config-service.ts';
import { checkRateLimit, clientIdentifier } from '../_shared/rate-limit.ts';

const ALLOWED_SOURCES = new Set([
  'landing_page','webinar','responder_form','lead_magnet','whatsapp_direct',
  'instagram_dm','manual_entry','screenshot_manual','unknown',
]);

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  const rawBody = await req.text();
  // Fail-closed: production must have INTAKE_WEBHOOK_SECRET set. Dev/local
  // can opt out via WEBHOOK_ALLOW_UNSIGNED=true.
  const secret = env.intakeWebhookSecret();
  if (!secret) {
    if (optional('WEBHOOK_ALLOW_UNSIGNED') !== 'true') {
      log.error('intake_webhook_misconfigured', { fn: 'leads-intake', correlationId });
      return jsonResponse(req, { error: 'Webhook not configured' }, 503);
    }
  } else {
    const valid = await verifyHmacHeader(req, rawBody, secret, 'x-karnaf-signature');
    if (!valid) {
      log.warn('intake_signature_invalid', { fn: 'leads-intake', correlationId });
      return jsonResponse(req, { error: 'Invalid signature' }, 401);
    }
  }

  let payload: Record<string, unknown>;
  try { payload = JSON.parse(rawBody); } catch {
    return jsonResponse(req, { error: 'Invalid JSON' }, 400);
  }

  const supabase = getServiceSupabase();
  const allowed = await checkRateLimit(supabase, {
    key: `intake:${clientIdentifier(req)}`,
    windowSeconds: 60,
    maxRequests: 60,
  });
  if (!allowed) {
    return jsonResponse(req, { error: 'Rate limit exceeded' }, 429);
  }

  const phoneRaw = (payload.phone ?? payload.mobile) as string | undefined;
  const phone = normalizeIsraeliPhone(phoneRaw ?? null);
  const emailRaw = typeof payload.email === 'string' ? payload.email.trim() : null;
  const email = emailRaw ? emailRaw.toLowerCase() : null;

  if (!phone && !email) {
    return jsonResponse(req, { error: 'Missing phone or email' }, 400);
  }

  const sourceInput = String(payload.source ?? 'unknown').toLowerCase();
  const source = ALLOWED_SOURCES.has(sourceInput) ? sourceInput : 'unknown';

  const lead = await upsertLead(supabase, {
    phone: phone ?? null,
    email,
    fullName: (payload.full_name as string | null) ?? null,
    source,
    intakeChannel: source.includes('whatsapp') ? 'whatsapp' : 'form',
    metadata: payload,
  });

  // Backfill optional structured fields without overwriting existing values.
  const updates: Record<string, unknown> = {};
  if (typeof payload.source_detail === 'string') updates.source_detail = payload.source_detail;
  if (typeof payload.campaign_name === 'string') updates.source_campaign = payload.campaign_name;
  if (typeof payload.webinar_name === 'string') updates.webinar_name = payload.webinar_name;
  if (typeof payload.lead_magnet_name === 'string') updates.lead_magnet_name = payload.lead_magnet_name;
  if (typeof payload.city === 'string') updates.city = payload.city;
  if (Object.keys(updates).length) {
    await supabase.from('leads').update(updates).eq('id', lead.id);
  }

  await logLeadEvent(supabase, lead.id, 'intake_received', 'system', {
    source, correlation_id: correlationId,
    matched_via: phone && lead.phone === phone ? 'phone' : email && lead.email === email ? 'email' : 'new',
  });

  // Source-specific first-response SLA, expressed in minutes for a single
  // source of truth; fallback is the runtime config (also minutes).
  const config = await getRuntimeConfig(supabase);
  const slaMinutesBySource: Record<string, number> = {
    whatsapp_direct: 30, instagram_dm: 30,
    webinar: 120, lead_magnet: 480, responder_form: 240, landing_page: 240,
  };
  const minutes = slaMinutesBySource[source] ?? config.followUpDelays.firstResponseMinutes;
  const dueAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();

  await ensurePendingQueueItem(supabase, {
    leadId: lead.id,
    queueType: 'first_response_due',
    priorityLevel: source === 'whatsapp_direct' || source === 'instagram_dm' ? 1 : 2,
    reason: 'New lead requires first response',
    payloadJson: { source, correlationId },
    dueAt,
  });

  log.info('lead_intake_accepted', { fn: 'leads-intake', correlationId, leadId: lead.id, source });
  return jsonResponse(req, { ok: true, leadId: lead.id, correlationId });
});
