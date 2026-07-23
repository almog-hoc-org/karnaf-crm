import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { logLeadEvent, upsertLead } from '../_shared/lead-service.ts';
import { normalizeIsraeliPhone } from '../_shared/phone.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { checkRateLimit, clientIdentifier } from '../_shared/rate-limit.ts';
import { getRuntimeConfig } from '../_shared/config-service.ts';
import { buildFirstTouchUpdates, deriveFbc, extractAttribution } from '../_shared/attribution.ts';
import { buildLeadContextFromRow } from '../_shared/event-context.ts';
import { runMatchingRules } from '../_shared/automation-engine.ts';
import { buildCapiEvent, buildUserData } from '../_shared/meta-capi.ts';
import { sendCapiEvents } from '../_shared/meta-capi-send.ts';

const MAX_NAME = 100;
const MAX_PHONE = 30;
const MAX_EMAIL = 254;
const MAX_SOURCE = 80;
const MAX_SERVICE = 40;
const MAX_MESSAGE = 1200;
const MAX_DETAIL = 120;
const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const WEBSITE_SOURCE_TO_CRM: Record<string, string> = {
  'fit-call-strip': 'responder_form',
  'fit-call-section': 'responder_form',
  footer: 'responder_form',
  website: 'landing_page',
  'contact-strip': 'responder_form',
  'services-page': 'landing_page',
  'course-page': 'lead_magnet',
  'course-waitlist': 'lead_magnet',
  // Presale project landing pages → presale track.
  'presale-pt': 'presale_form',
  'presale-pt-sinai': 'presale_form',
};

function sanitize(val: unknown, maxLen: number): string {
  return typeof val === 'string' ? val.trim().slice(0, maxLen) : '';
}

function sourceToCrm(source: string, service: string): string {
  if (source.includes('webinar') || service === 'webinar') return 'webinar';
  if (service === 'waitlist') return 'lead_magnet';
  return WEBSITE_SOURCE_TO_CRM[source] ?? 'responder_form';
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch {
    return jsonResponse(req, { error: 'Invalid JSON' }, 400);
  }

  const name = sanitize(payload.name ?? payload.full_name, MAX_NAME);
  const phoneRaw = sanitize(payload.phone ?? payload.mobile, MAX_PHONE);
  const phone = normalizeIsraeliPhone(phoneRaw) ?? phoneRaw;
  const emailRaw = sanitize(payload.email, MAX_EMAIL).toLowerCase();
  const email = emailRaw || null;
  const service = sanitize(payload.service, MAX_SERVICE).toLowerCase();
  const sourceDetail = sanitize(payload.source, MAX_SOURCE).toLowerCase() || 'website';
  const source = sourceToCrm(sourceDetail, service);
  const message = sanitize(payload.message, MAX_MESSAGE);
  const stage = sanitize(payload.stage, MAX_DETAIL);
  const equity = sanitize(payload.equity, MAX_DETAIL);

  if (!name || !phone) {
    return jsonResponse(req, { error: 'Missing required name or phone' }, 400);
  }
  if (email && !EMAIL_REGEX.test(email)) {
    return jsonResponse(req, { error: 'Invalid email' }, 400);
  }

  // Honeypot: a hidden field real users never fill. Bots that do get a
  // silent success and no lead.
  if (sanitize(payload.company_website, 200)) {
    return jsonResponse(req, { ok: true });
  }

  const supabase = getServiceSupabase();
  const allowed = await checkRateLimit(supabase, {
    key: `website-lead:${clientIdentifier(req)}`,
    windowSeconds: 60 * 60,
    maxRequests: 10,
  });
  if (!allowed) return jsonResponse(req, { error: 'Rate limit exceeded' }, 429);

  // In-system landing pages: lp_slug must match an ACTIVE landing_pages
  // row — the page's campaign becomes source_campaign, and unknown slugs
  // are rejected so nobody can inject arbitrary campaigns through the
  // public endpoint. Tighter per-slug rate limit on top of the global.
  const lpSlug = sanitize(payload.lp_slug, 60).toLowerCase();
  let lpCampaign: string | null = null;
  let lpSource: string | null = null;
  if (lpSlug) {
    if (!/^[a-z0-9-]{2,60}$/.test(lpSlug)) {
      return jsonResponse(req, { error: 'Unknown landing page' }, 404);
    }
    const { data: lp } = await supabase
      .from('landing_pages')
      .select('slug, campaign, source, active')
      .eq('slug', lpSlug)
      .eq('active', true)
      .maybeSingle();
    if (!lp) return jsonResponse(req, { error: 'Unknown landing page' }, 404);
    const lpAllowed = await checkRateLimit(supabase, {
      key: `website-lead:lp:${lpSlug}:${clientIdentifier(req)}`,
      windowSeconds: 60 * 60,
      maxRequests: 5,
    });
    if (!lpAllowed) return jsonResponse(req, { error: 'Rate limit exceeded' }, 429);
    lpCampaign = lp.campaign as string;
    lpSource = lp.source as string;
  }

  const attrs = extractAttribution(payload);
  const campaign = lpCampaign ?? attrs.utm_campaign ?? 'karnaf_website';

  try {
    const lead = await upsertLead(supabase, {
      phone,
      email,
      fullName: name,
      source: lpSource ?? source,
      intakeChannel: 'form',
      metadata: {
        ...payload,
        name,
        full_name: name,
        phone,
        email,
        service: service || null,
        source: lpSource ?? source,
        source_detail: sourceDetail,
        campaign_name: campaign,
        stage: stage || null,
        equity: equity || null,
        message: message || null,
        correlation_id: correlationId,
      },
    });

    // First-touch attribution: utm_*/landing_page/referrer/fbp/fbc columns
    // fill only when empty; the submission is always recorded in last_touch.
    // source_detail/source_campaign follow the same first-touch rule (they
    // used to be overwritten on every re-submission).
    const updates = buildFirstTouchUpdates(lead, attrs, new Date().toISOString());
    if (!lead.source_detail) updates.source_detail = lpSlug || sourceDetail;
    if (!lead.source_campaign) updates.source_campaign = campaign;
    if (!lead.estimated_equity && equity) updates.estimated_equity = equity;
    if (message) updates.pain_point_summary = message;
    // Presale landing pages carry a known track so the AI bot converses about
    // the presale project (not the flagship program). resolveTrackContext reads primary_track.
    if (source === 'presale_form') updates.primary_track = 'presale';
    const { error: updateErr } = await supabase.from('leads').update(updates).eq('id', lead.id);
    if (updateErr) log.warn('website_lead_update_failed', { fn: 'website-leads-intake', correlationId, err: updateErr.message });

    await logLeadEvent(supabase, lead.id, 'intake_received', 'system', {
      source,
      source_detail: sourceDetail,
      service: service || null,
      stage: stage || null,
      equity: equity || null,
      message: message || null,
      correlation_id: correlationId,
      channel: 'karnaf_website',
    });

    const config = await getRuntimeConfig(supabase);
    const slaMinutesBySource: Record<string, number> = { webinar: 120, lead_magnet: 480, responder_form: 240, landing_page: 240 };
    const minutes = slaMinutesBySource[source] ?? config.followUpDelays.firstResponseMinutes;
    const dueAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();

    await ensurePendingQueueItem(supabase, {
      leadId: lead.id,
      queueType: 'first_response_due',
      priorityLevel: 2,
      reason: 'Website form lead requires first response',
      queueSummary: message || sourceDetail,
      payloadJson: { source, sourceDetail, service: service || null, correlationId },
      dueAt,
    });

    // Emit lead.created for the automation engine — but only for genuinely
    // NEW leads. upsert_lead_smart sets created_at and updated_at from the
    // same statement's now() on INSERT (identical), and bumps only
    // updated_at on a match — so equality is a deterministic new-lead
    // signal with no schema change. Re-submissions never re-enroll.
    // Fail-safe: any error here must not lose the lead response.
    if (lead.created_at === lead.updated_at) {
      try {
        const leadCtx = await buildLeadContextFromRow(supabase, {
          id: lead.id,
          full_name: lead.full_name,
          phone: lead.phone,
          email: lead.email,
          do_not_contact: lead.do_not_contact,
          primary_track: source === 'presale_form' ? 'presale' : null,
          source: lpSource ?? source,
          source_campaign: campaign,
          created_at: lead.created_at as string,
        });
        await runMatchingRules(supabase, {
          triggerEvent: 'lead.created',
          context: { lead: leadCtx },
          contactId: lead.id,
          correlationId,
        });
      } catch (ruleErr) {
        log.warn('website_lead_rules_failed', { fn: 'website-leads-intake', correlationId, leadId: lead.id, err: String(ruleErr) });
      }
    }

    // Meta CAPI Lead event — fire-and-forget, silent no-op until the
    // operator provisions META_PIXEL_ID + META_CAPI_TOKEN. event_id
    // prefers the browser pixel's id (when the site forwards one) so
    // Meta dedups the browser/server pair.
    try {
      const userData = await buildUserData({
        email,
        phone,
        fbp: attrs.fbp,
        fbc: attrs.fbc ?? deriveFbc(attrs.fbclid, Date.now()),
      });
      await sendCapiEvents([
        buildCapiEvent({
          eventName: 'Lead',
          eventId: attrs.event_id ?? correlationId,
          eventTimeSec: Date.now() / 1000,
          sourceUrl: attrs.page_url,
          userData,
        }),
      ], correlationId);
    } catch (capiErr) {
      log.warn('capi_lead_failed', { fn: 'website-leads-intake', correlationId, err: String(capiErr) });
    }

    log.info('website_lead_accepted', { fn: 'website-leads-intake', correlationId, leadId: lead.id, source, sourceDetail });
    return jsonResponse(req, { ok: true, leadId: lead.id, correlationId });
  } catch (err) {
    log.error('website_lead_failed', { fn: 'website-leads-intake', correlationId, err: String(err) });
    return jsonResponse(req, { error: 'Failed to save lead' }, 500);
  }
});
