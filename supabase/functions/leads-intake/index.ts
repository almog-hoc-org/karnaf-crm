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
import { classifyLeadIntake } from '../_shared/lead-classifier.ts';

const FALLBACK_ALLOWED_SOURCES = new Set([
  'landing_page',
  'webinar',
  'responder_form',
  'lead_magnet',
  'whatsapp_direct',
  'instagram_dm',
  'manual_entry',
  'screenshot_manual',
  'unknown',
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
  const { data, error } = await supabase.from('lead_sources').select('slug').eq('is_active', true);
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
  try {
    payload = JSON.parse(rawBody);
  } catch {
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
      fn: 'leads-intake',
      correlationId,
      key: idempotencyKey,
      explicit: !!explicitIdempotencyKey,
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

  const sourceDetail = typeof payload.source_detail === 'string' ? payload.source_detail : null;
  const sourceCampaign = typeof payload.campaign_name === 'string' ? payload.campaign_name : null;
  const firstMessage =
    typeof payload.message === 'string'
      ? payload.message
      : typeof payload.initial_message === 'string'
        ? payload.initial_message
        : typeof payload.notes === 'string'
          ? payload.notes
          : null;
  const classification = classifyLeadIntake({
    source,
    sourceDetail,
    sourceCampaign,
    firstMessage,
    latestMessage: firstMessage,
    metadata: payload,
  });

  const prdTrack = resolvePrdTrack(payload, classification.productInterest, source);
  const prdStage = resolveInitialStage(prdTrack, payload);
  const interestTopic = resolveInterestTopic(payload, classification.productInterest);
  const tags = resolveTags(payload, source, prdTrack);
  const currentTracks = Array.isArray(lead.active_tracks) ? lead.active_tracks.filter((t) => typeof t === 'string') as string[] : [];
  const activeTracks = prdTrack ? [...new Set([...currentTracks, prdTrack])] : currentTracks;

  // Backfill optional structured fields without rewriting identity/routing data.
  const updates: Record<string, unknown> = {
    inquiry_type: classification.inquiryType,
    product_interest: classification.productInterest,
    intake_segment: classification.intakeSegment,
    classification_confidence: classification.confidence,
    classification_summary: classification.operatorSummary,
    suggested_next_action: classification.suggestedNextAction,
    handoff_reason: classification.handoffReason,
    classification_updated_at: new Date().toISOString(),
    primary_track: (lead.primary_track as string | null | undefined) ?? prdTrack,
    active_tracks: activeTracks,
    interest_topic: interestTopic,
    tags,
  };
  if (typeof payload.consent_whatsapp === 'boolean') updates.consent_whatsapp = payload.consent_whatsapp;
  if (typeof payload.consent_email === 'boolean') updates.consent_email = payload.consent_email;
  if (typeof payload.consent_whatsapp === 'boolean' || typeof payload.consent_email === 'boolean') {
    updates.consent_updated_at = new Date().toISOString();
  }
  if (sourceDetail) updates.source_detail = sourceDetail;
  if (sourceCampaign) updates.source_campaign = sourceCampaign;
  if (typeof payload.webinar_name === 'string') updates.webinar_name = payload.webinar_name;
  if (typeof payload.lead_magnet_name === 'string') updates.lead_magnet_name = payload.lead_magnet_name;
  if (typeof payload.city === 'string') updates.city = payload.city;
  await supabase.from('leads').update(updates).eq('id', lead.id);

  if (prdTrack && prdStage) {
    const dealPatch = {
      stage: prdStage,
      source,
      presale_project: typeof payload.presale_project === 'string' ? payload.presale_project : null,
      partner_name: typeof payload.partner_name === 'string' ? payload.partner_name : null,
      metadata: {
        sourceDetail,
        sourceCampaign,
        productInterest: classification.productInterest,
        intakeSegment: classification.intakeSegment,
      },
    };
    const { data: existingDeal } = await supabase
      .from('deals')
      .select('id')
      .eq('lead_id', lead.id)
      .eq('track', prdTrack)
      .eq('status', 'open')
      .maybeSingle();
    if (existingDeal?.id) {
      await supabase.from('deals').update(dealPatch).eq('id', existingDeal.id);
    } else {
      await supabase.from('deals').insert({
        lead_id: lead.id,
        track: prdTrack,
        status: 'open',
        ...dealPatch,
      });
    }
  }

  await logLeadEvent(supabase, lead.id, 'intake_received', 'system', {
    source,
    correlation_id: correlationId,
    matched_via: phone && lead.phone === phone ? 'phone' : email && lead.email === email ? 'email' : 'new',
    classification,
    prd_track: prdTrack,
    prd_stage: prdStage,
  });

  // Source-specific first-response SLA, expressed in minutes for a single
  // source of truth; fallback is the runtime config (also minutes).
  const config = await getRuntimeConfig(supabase);
  const slaMinutesBySource: Record<string, number> = {
    whatsapp_direct: 30,
    instagram_dm: 30,
    webinar: 120,
    lead_magnet: 480,
    responder_form: 240,
    landing_page: 240,
  };
  const minutes = slaMinutesBySource[source] ?? config.followUpDelays.firstResponseMinutes;
  const dueAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();

  await ensurePendingQueueItem(supabase, {
    leadId: lead.id,
    queueType: 'first_response_due',
    priorityLevel: source === 'whatsapp_direct' || source === 'instagram_dm' ? 1 : 2,
    reason: classification.handoffReason ?? 'New lead requires first response',
    queueSummary: classification.operatorSummary,
    payloadJson: { source, correlationId, classification },
    dueAt,
  });

  log.info('lead_intake_accepted', { fn: 'leads-intake', correlationId, leadId: lead.id, source });
  const response = { ok: true as const, leadId: lead.id, correlationId };
  // Fire-and-forget the idempotency write; failure here doesn't change
  // the caller-visible behaviour (worst case: duplicate work on retry).
  storeWebhookIdempotencyResponse(supabase, idempotencyKey, 'intake', response).catch((err) =>
    log.error('intake_idempotency_store_failed', {
      fn: 'leads-intake',
      correlationId,
      err: String(err),
    }),
  );
  return jsonResponse(req, response);
});

function resolvePrdTrack(payload: Record<string, unknown>, productInterest: string | null, source: string): string | null {
  const explicit = normaliseTrack(payload.track ?? payload.pipeline ?? payload.product_track);
  if (explicit) return explicit;
  if (productInterest === 'digital_program' || source === 'webinar') return 'program';
  if (productInterest === 'investor_mentorship') return 'investor_mentorship';
  if (productInterest === 'contractor_group_purchase') return 'presale';
  const topic = String(payload.interest_topic ?? payload.project ?? '').toLowerCase();
  if (topic.includes('פריסייל') || topic.includes('presale')) return 'presale';
  return null;
}

function normaliseTrack(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['program', 'digital_program', 'תכנית_ליווי', 'תוכנית_ליווי'].includes(raw)) return 'program';
  if (['presale', 'פריסייל', 'חתימה'].includes(raw)) return 'presale';
  if (['investor_mentorship', 'investor', 'ליווי_משקיעים'].includes(raw)) return 'investor_mentorship';
  return null;
}

function resolveInitialStage(track: string | null, payload: Record<string, unknown>): string | null {
  const explicit = typeof payload.stage === 'string' ? payload.stage.trim() : '';
  if (explicit) return explicit;
  if (track === 'program') {
    if (payload.webinar_id || payload.webinar_name || payload.webinar_date) return 'webinar_registered';
    if (payload.preferred_time || payload.call_time) return 'phone_call_booked';
    return 'new';
  }
  if (track === 'presale') return 'new';
  if (track === 'investor_mentorship') return 'form_submitted';
  return null;
}

function resolveInterestTopic(payload: Record<string, unknown>, productInterest: string | null): string | null {
  for (const key of ['interest_topic', 'topic', 'presale_project', 'project']) {
    if (typeof payload[key] === 'string' && payload[key].trim()) return payload[key].trim().slice(0, 180);
  }
  return productInterest;
}

function resolveTags(payload: Record<string, unknown>, source: string, track: string | null): string[] {
  const out = new Set<string>([source]);
  if (track) out.add(track);
  const raw = payload.tags;
  if (Array.isArray(raw)) {
    for (const t of raw) if (typeof t === 'string' && t.trim()) out.add(t.trim().slice(0, 60));
  } else if (typeof raw === 'string') {
    for (const t of raw.split(',')) if (t.trim()) out.add(t.trim().slice(0, 60));
  }
  return [...out].slice(0, 20);
}
