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
  'webinar_registration',
  'phone_call_request',
  'presale_form',
  'investor_mentorship_form',
  'whatsapp_topic_selection',
  'unknown',
]);

interface IntakeContract {
  contract_key: string;
  source_slug: string;
  display_name: string;
  required_fields: string[];
  field_aliases: Record<string, string[]>;
  default_track: string | null;
  default_stage: string | null;
  default_interest_topic: string | null;
  default_tags: string[];
}

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

async function loadIntakeContract(
  supabase: ReturnType<typeof getServiceSupabase>,
  source: string,
  payload: Record<string, unknown>,
): Promise<IntakeContract | null> {
  const requestedKey = typeof payload.contract_key === 'string'
    ? payload.contract_key.trim()
    : typeof payload.form_type === 'string'
      ? payload.form_type.trim()
      : null;
  let query = supabase
    .from('intake_source_contracts')
    .select('contract_key, source_slug, display_name, required_fields, field_aliases, default_track, default_stage, default_interest_topic, default_tags')
    .eq('is_active', true);
  if (requestedKey) query = query.eq('contract_key', requestedKey);
  else query = query.eq('source_slug', source).order('contract_key', { ascending: true }).limit(1);

  const { data, error } = await query.maybeSingle();
  if (error) {
    log.warn('intake_contract_lookup_failed', { fn: 'leads-intake', source, contractKey: requestedKey, err: error.message });
    return null;
  }
  if (!data) return null;
  if (data.source_slug !== source) {
    log.warn('intake_contract_source_mismatch', { fn: 'leads-intake', source, contractKey: data.contract_key, contractSource: data.source_slug });
    return null;
  }
  return {
    contract_key: data.contract_key as string,
    source_slug: data.source_slug as string,
    display_name: data.display_name as string,
    required_fields: Array.isArray(data.required_fields) ? data.required_fields.filter((f): f is string => typeof f === 'string') : [],
    field_aliases: normaliseAliases(data.field_aliases),
    default_track: typeof data.default_track === 'string' ? data.default_track : null,
    default_stage: typeof data.default_stage === 'string' ? data.default_stage : null,
    default_interest_topic: typeof data.default_interest_topic === 'string' ? data.default_interest_topic : null,
    default_tags: Array.isArray(data.default_tags) ? data.default_tags.filter((t): t is string => typeof t === 'string') : [],
  };
}

function normaliseAliases(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [canonical, aliases] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(aliases)) continue;
    out[canonical] = aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0);
  }
  return out;
}

function applyContractAliases(payload: Record<string, unknown>, contract: IntakeContract): Record<string, unknown> {
  const out = { ...payload };
  for (const [canonical, aliases] of Object.entries(contract.field_aliases)) {
    if (hasValue(out[canonical])) continue;
    const match = aliases.find((alias) => hasValue(out[alias]));
    if (match) out[canonical] = out[match];
  }
  return out;
}

function missingRequiredContractFields(payload: Record<string, unknown>, contract: IntakeContract): string[] {
  return contract.required_fields.filter((field) => !hasValue(payload[field]));
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
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

  const sourceInput = String(payload.source ?? 'unknown').toLowerCase();
  const allowedSources = await loadAllowedSources(supabase);
  const source = allowedSources.has(sourceInput) ? sourceInput : 'unknown';
  const contract = await loadIntakeContract(supabase, source, payload);
  const normalisedPayload = contract ? applyContractAliases(payload, contract) : payload;
  const phoneRaw = (normalisedPayload.phone ?? normalisedPayload.mobile) as string | undefined;
  const phone = normalizeIsraeliPhone(phoneRaw ?? null);
  const emailRaw = typeof normalisedPayload.email === 'string' ? normalisedPayload.email.trim() : null;
  const email = emailRaw ? emailRaw.toLowerCase() : null;

  if (!phone && !email) {
    return jsonResponse(req, { error: 'Missing phone or email' }, 400);
  }

  const missingContractFields = contract ? missingRequiredContractFields(normalisedPayload, contract) : [];
  if (missingContractFields.length > 0) {
    return jsonResponse(req, {
      error: 'Missing required contract fields',
      contractKey: contract?.contract_key,
      missingFields: missingContractFields,
    }, 400);
  }

  const lead = await upsertLead(supabase, {
    phone: phone ?? null,
    email,
    fullName: (normalisedPayload.full_name as string | null) ?? null,
    source,
    intakeChannel: source.includes('whatsapp') ? 'whatsapp' : 'form',
    metadata: { ...payload, _intake_contract: contract?.contract_key ?? null },
  });

  const sourceDetail = typeof normalisedPayload.source_detail === 'string' ? normalisedPayload.source_detail : null;
  const sourceCampaign = typeof normalisedPayload.campaign_name === 'string' ? normalisedPayload.campaign_name : null;
  const firstMessage =
    typeof normalisedPayload.message === 'string'
      ? normalisedPayload.message
      : typeof normalisedPayload.initial_message === 'string'
        ? normalisedPayload.initial_message
        : typeof normalisedPayload.notes === 'string'
          ? normalisedPayload.notes
          : null;
  const classification = classifyLeadIntake({
    source,
    sourceDetail,
    sourceCampaign,
    firstMessage,
    latestMessage: firstMessage,
    metadata: normalisedPayload,
  });

  const prdTrack = contract?.default_track ?? resolvePrdTrack(normalisedPayload, classification.productInterest, source);
  const prdStage = contract?.default_stage ?? resolveInitialStage(prdTrack, normalisedPayload);
  const interestTopic = contract?.default_interest_topic ?? resolveInterestTopic(normalisedPayload, classification.productInterest);
  const tags = resolveTags(normalisedPayload, source, prdTrack, contract?.default_tags ?? []);
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
  if (typeof normalisedPayload.consent_whatsapp === 'boolean') updates.consent_whatsapp = normalisedPayload.consent_whatsapp;
  if (typeof normalisedPayload.consent_email === 'boolean') updates.consent_email = normalisedPayload.consent_email;
  if (typeof normalisedPayload.consent_whatsapp === 'boolean' || typeof normalisedPayload.consent_email === 'boolean') {
    updates.consent_updated_at = new Date().toISOString();
  }
  if (sourceDetail) updates.source_detail = sourceDetail;
  if (sourceCampaign) updates.source_campaign = sourceCampaign;
  if (typeof normalisedPayload.webinar_name === 'string') updates.webinar_name = normalisedPayload.webinar_name;
  if (typeof normalisedPayload.lead_magnet_name === 'string') updates.lead_magnet_name = normalisedPayload.lead_magnet_name;
  if (typeof normalisedPayload.city === 'string') updates.city = normalisedPayload.city;
  await supabase.from('leads').update(updates).eq('id', lead.id);

  if (prdTrack && prdStage) {
    const dealPatch = {
      stage: prdStage,
      source,
      presale_project: typeof normalisedPayload.presale_project === 'string' ? normalisedPayload.presale_project : null,
      partner_name: typeof normalisedPayload.partner_name === 'string' ? normalisedPayload.partner_name : null,
      metadata: {
        sourceDetail,
        sourceCampaign,
        productInterest: classification.productInterest,
        intakeSegment: classification.intakeSegment,
        intakeContract: contract?.contract_key ?? null,
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
    intake_contract: contract?.contract_key ?? null,
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
    payloadJson: { source, correlationId, classification, intakeContract: contract?.contract_key ?? null },
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

function resolveTags(payload: Record<string, unknown>, source: string, track: string | null, defaults: string[] = []): string[] {
  const out = new Set<string>([source, ...defaults]);
  if (track) out.add(track);
  const raw = payload.tags;
  if (Array.isArray(raw)) {
    for (const t of raw) if (typeof t === 'string' && t.trim()) out.add(t.trim().slice(0, 60));
  } else if (typeof raw === 'string') {
    for (const t of raw.split(',')) if (t.trim()) out.add(t.trim().slice(0, 60));
  }
  return [...out].slice(0, 20);
}
