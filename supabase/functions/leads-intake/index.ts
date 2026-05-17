import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { logLeadEvent, upsertLead } from '../_shared/lead-service.ts';
import { normalizeIsraeliPhone } from '../_shared/phone.ts';
import { verifyHmacHeader } from '../_shared/webhook-signature.ts';
import {
  getWebhookIdempotencyResponse,
  hashBody,
  storeWebhookIdempotencyResponse,
} from '../_shared/idempotency.ts';
import { env, optional } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { getRuntimeConfig } from '../_shared/config-service.ts';
import { checkRateLimit, clientIdentifier } from '../_shared/rate-limit.ts';

const FALLBACK_ALLOWED_SOURCES = new Set([
  'landing_page','webinar','responder_form','lead_magnet','whatsapp_direct',
  'instagram_dm','manual_entry','screenshot_manual','unknown',
]);

// Edge-function instances are short-lived but reused across invocations
// while warm. Cache the active source slugs for 5 minutes so the admin
// panel changes propagate quickly without hammering the DB every request.
const SOURCES_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedSources: { fetchedAt: number; slugs: Set<string> } | null = null;

async function loadAllowedSources(supabase: ReturnType<typeof getServiceSupabase>): Promise<Set<string>> {
  if (cachedSources && Date.now() - cachedSources.fetchedAt < SOURCES_CACHE_TTL_MS) {
    return cachedSources.slugs;
  }
  const { data, error } = await supabase
    .from('lead_sources')
    .select('slug')
    .eq('is_active', true);
  if (error) {
    // Fail open to the hard-coded set — refusing intake during a DB
    // hiccup is worse than accepting a known-good slug.
    log.warn('lead_sources_lookup_failed', { fn: 'leads-intake', err: error.message });
    return FALLBACK_ALLOWED_SOURCES;
  }
  const slugs = new Set<string>((data ?? []).map((r) => r.slug as string));
  // Defensive: always honour 'unknown' even if the row was deleted.
  slugs.add('unknown');
  cachedSources = { fetchedAt: Date.now(), slugs };
  return slugs;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  const rawBody = await req.text();
  // Fail-closed: production must have INTAKE_WEBHOOK_SECRET set. A missing
  // secret used to skip verification entirely (fail-open). Dev/local can
  // opt out via WEBHOOK_ALLOW_UNSIGNED=true.
  const secret = env.intakeWebhookSecret();
  if (!secret) {
    // Fail closed unless explicitly opted out (dev/local).
    if (optional('WEBHOOK_ALLOW_UNSIGNED') !== 'true') {
      log.error('intake_webhook_misconfigured', { fn: 'leads-intake', correlationId });
      return jsonResponse(req, { error: 'Webhook not configured' }, 503);
    }
  } else {
    // Accept both x-karnaf-signature (canonical) and x-intake-signature
    // (legacy — integration test harness + some pre-prod callers). Drop
    // the legacy name after the next deploy cycle.
    const valid = await verifyHmacHeader(req, rawBody, secret, ['x-karnaf-signature', 'x-intake-signature']);
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

  // Request-level idempotency. Prefer an explicit header (Zapier / Make
  // can be configured to send one) and fall back to a SHA-256 of the
  // body so plain retries within the TTL still de-dup.
  const explicitIdempotencyKey = req.headers.get('idempotency-key')?.trim() || null;
  const idempotencyKey = `intake:${explicitIdempotencyKey ?? (await hashBody(rawBody))}`;
  const cached = await getWebhookIdempotencyResponse(supabase, idempotencyKey);
  if (cached) {
    log.info('intake_idempotency_hit', {
      fn: 'leads-intake', correlationId, key: idempotencyKey, explicit: !!explicitIdempotencyKey,
    });
    return jsonResponse(req, { ...cached, idempotent: true });
  }

  const phoneRaw = (payload.phone ?? payload.mobile) as string | undefined;
  const phone = normalizeIsraeliPhone(phoneRaw ?? null);
  const emailRaw = typeof payload.email === 'string' ? payload.email.trim() : null;
  const email = emailRaw ? emailRaw.toLowerCase() : null;

  if (!phone && !email) {
    return jsonResponse(req, { error: 'Missing phone or email' }, 400);
  }

  const sourceInput = String(payload.source ?? 'unknown').toLowerCase();
  const allowedSources = await loadAllowedSources(supabase);
  const source = allowedSources.has(sourceInput) ? sourceInput : 'unknown';

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
  const response = { ok: true as const, leadId: lead.id, correlationId };
  // Fire-and-forget the idempotency write; failure here doesn't change
  // the caller-visible behaviour (worst case: duplicate work on retry).
  storeWebhookIdempotencyResponse(supabase, idempotencyKey, 'intake', response).catch(
    (err) => log.error('intake_idempotency_store_failed', {
      fn: 'leads-intake', correlationId, err: String(err),
    }),
  );
  return jsonResponse(req, response);
});
