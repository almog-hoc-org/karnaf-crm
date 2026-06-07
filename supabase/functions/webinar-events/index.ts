import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { normalizeIsraeliPhone } from '../_shared/phone.ts';
import { verifyHmacHeader } from '../_shared/webhook-signature.ts';
import { env, optional } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { logLeadEvent, upsertLead } from '../_shared/lead-service.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  const rawBody = await req.text();
  const secret = env.intakeWebhookSecret();
  if (!secret) {
    if (optional('WEBHOOK_ALLOW_UNSIGNED') !== 'true') {
      log.error('webinar_events_misconfigured', { fn: 'webinar-events', correlationId });
      return jsonResponse(req, { error: 'Webhook not configured' }, 503);
    }
  } else {
    const valid = await verifyHmacHeader(req, rawBody, secret, ['x-karnaf-signature', 'x-intake-signature']);
    if (!valid) return jsonResponse(req, { error: 'Invalid signature' }, 401);
  }

  let payload: Record<string, unknown>;
  try { payload = JSON.parse(rawBody); } catch {
    return jsonResponse(req, { error: 'Invalid JSON' }, 400);
  }

  const eventType = String(payload.event_type ?? payload.type ?? 'registration').toLowerCase();
  const phone = normalizeIsraeliPhone(((payload.phone ?? payload.mobile) as string | null) ?? null);
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase().trim() : null;
  if (!phone && !email) return jsonResponse(req, { error: 'Missing phone or email' }, 400);

  const webinarTitle = String(payload.webinar_title ?? payload.webinar_name ?? 'וובינר קרנף נדלן');
  const startsAt = resolveStartsAt(payload);
  if (!startsAt) return jsonResponse(req, { error: 'Missing webinar starts_at/webinar_date' }, 400);

  const supabase = getServiceSupabase();
  const lead = await upsertLead(supabase, {
    phone,
    email,
    fullName: typeof payload.full_name === 'string' ? payload.full_name : null,
    source: 'webinar',
    intakeChannel: 'form',
    metadata: payload,
  });

  const leadUpdates: Record<string, unknown> = {
    primary_track: 'program',
    active_tracks: ['program'],
    interest_topic: webinarTitle,
    webinar_name: webinarTitle,
  };
  if (typeof payload.consent_whatsapp === 'boolean') leadUpdates.consent_whatsapp = payload.consent_whatsapp;
  if (typeof payload.consent_email === 'boolean') leadUpdates.consent_email = payload.consent_email;
  if (typeof payload.consent_whatsapp === 'boolean' || typeof payload.consent_email === 'boolean') {
    leadUpdates.consent_updated_at = new Date().toISOString();
  }
  await supabase.from('leads').update(leadUpdates).eq('id', lead.id);

  const externalWebinarId = typeof payload.webinar_external_id === 'string' ? payload.webinar_external_id : null;
  let webinarId: string | null = null;
  if (externalWebinarId) {
    const { data: existing } = await supabase
      .from('webinars')
      .select('id')
      .eq('metadata->>external_id', externalWebinarId)
      .maybeSingle();
    webinarId = existing?.id ?? null;
  }
  if (!webinarId) {
    const { data: byTime } = await supabase
      .from('webinars')
      .select('id')
      .eq('title', webinarTitle)
      .eq('starts_at', startsAt)
      .maybeSingle();
    webinarId = byTime?.id ?? null;
  }
  if (!webinarId) {
    const { data: created, error: createErr } = await supabase.from('webinars').insert({
      title: webinarTitle,
      starts_at: startsAt,
      zoom_link: typeof payload.zoom_link === 'string' ? payload.zoom_link : null,
      metadata: { external_id: externalWebinarId, correlationId },
    }).select('id').single();
    if (createErr) return jsonResponse(req, { error: createErr.message }, 500);
    webinarId = created.id as string;
  }

  const attended = eventType.includes('attend') ? true : eventType.includes('no_show') ? false : undefined;
  const purchased = eventType.includes('purchase') || eventType.includes('paid') ? true : undefined;
  const registrationPatch: Record<string, unknown> = {
    lead_id: lead.id,
    webinar_id: webinarId,
    source: String(payload.source ?? 'webinar'),
    metadata: { correlationId, eventType, raw: payload },
  };
  if (typeof attended === 'boolean') registrationPatch.attended = attended;
  if (typeof purchased === 'boolean') registrationPatch.purchased = purchased;
  const { error: regErr } = await supabase.from('webinar_registrations').upsert(registrationPatch, { onConflict: 'lead_id,webinar_id' });
  if (regErr) return jsonResponse(req, { error: regErr.message }, 500);

  const stage = purchased ? 'paid_program_member' : attended ? 'webinar_attended' : 'webinar_registered';
  const { data: existingDeal } = await supabase
    .from('deals')
    .select('id')
    .eq('lead_id', lead.id)
    .eq('track', 'program')
    .eq('status', 'open')
    .maybeSingle();
  if (existingDeal?.id) {
    await supabase.rpc('advance_deal_stage', {
      p_deal_id: existingDeal.id,
      p_to_stage: stage,
      p_actor_type: 'provider',
      p_reason: `webinar_${eventType}`,
      p_actor_id: null,
      p_metadata: { correlationId, webinarId },
    });
  } else {
    await supabase.from('deals').insert({
      lead_id: lead.id,
      track: 'program',
      stage,
      status: stage === 'paid_program_member' ? 'won' : 'open',
      source: 'webinar',
      metadata: { correlationId, webinarId, eventType },
    });
  }

  if (eventType === 'registration' || eventType === 'registered') {
    await ensurePendingQueueItem(supabase, {
      leadId: lead.id,
      queueType: 'webinar_registered',
      priorityLevel: 3,
      reason: 'נרשם לוובינר — לוודא רצף תזכורות ומעקב אחרי האירוע',
      dueAt: startsAt,
      payloadJson: { correlationId, webinarId, webinarTitle },
    });
  } else if (attended === true && !purchased) {
    await ensurePendingQueueItem(supabase, {
      leadId: lead.id,
      queueType: 'webinar_attended_not_purchased',
      priorityLevel: 1,
      reason: 'השתתף בוובינר ולא רכש — נדרש טיפול טלפוני/המשך',
      dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      payloadJson: { correlationId, webinarId, webinarTitle },
    });
  } else if (attended === false) {
    await ensurePendingQueueItem(supabase, {
      leadId: lead.id,
      queueType: 'webinar_no_show',
      priorityLevel: 2,
      reason: 'נרשם לוובינר ולא השתתף — נדרש follow-up',
      dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      payloadJson: { correlationId, webinarId, webinarTitle },
    });
  }

  await logLeadEvent(supabase, lead.id, 'webinar_event_received', 'provider', {
    correlation_id: correlationId,
    event_type: eventType,
    webinar_id: webinarId,
    stage,
  });

  return jsonResponse(req, { ok: true, leadId: lead.id, webinarId, stage, correlationId });
});

function resolveStartsAt(payload: Record<string, unknown>): string | null {
  const raw = payload.starts_at ?? payload.webinar_date ?? payload.date;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
