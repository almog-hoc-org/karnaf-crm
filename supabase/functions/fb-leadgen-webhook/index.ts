// Facebook Lead Ads webhook ingestion.
//
// Meta delivers a `leadgen` event with just an id reference; you must call
// the Graph API to retrieve the actual `field_data`. We do that hydration
// inline if FACEBOOK_PAGE_ACCESS_TOKEN is configured. If it isn't, we still
// persist a placeholder lead and queue it as manual_review_required so
// nothing gets dropped — the operator can finish hydration manually later.
//
// Verification handshake matches IG / WhatsApp.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { logLeadEvent, upsertLead } from '../_shared/lead-service.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { verifyMetaSignature } from '../_shared/webhook-signature.ts';
import { normalizeIsraeliPhone } from '../_shared/phone.ts';
import { env, safeEqual } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { checkRateLimit, clientIdentifier } from '../_shared/rate-limit.ts';

interface LeadgenChange {
  value: {
    leadgen_id?: string;
    page_id?: string;
    form_id?: string;
    ad_id?: string;
    adgroup_id?: string;
    campaign_id?: string;
    created_time?: number;
  };
  field?: string;
}

interface GraphFieldData {
  name: string;
  values: string[];
}

interface GraphLeadgen {
  id: string;
  created_time?: string;
  field_data?: GraphFieldData[];
}

function fieldOf(fields: GraphFieldData[] | undefined, ...names: string[]): string | null {
  if (!fields) return null;
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const f of fields) {
    if (wanted.has(f.name.toLowerCase()) && f.values?.length) return f.values[0];
  }
  return null;
}

async function hydrateLeadgen(leadgenId: string): Promise<GraphLeadgen | null> {
  const token = env.facebookPageAccessToken();
  if (!token) return null;
  const url = `https://graph.facebook.com/${env.metaGraphVersion()}/${leadgenId}?fields=id,created_time,field_data&access_token=${encodeURIComponent(token)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      log.warn('fb_leadgen_hydrate_failed', { leadgenId, status: r.status, body: (await r.text()).slice(0, 400) });
      return null;
    }
    return await r.json() as GraphLeadgen;
  } catch (err) {
    log.warn('fb_leadgen_hydrate_exception', { leadgenId, err: String(err) });
    return null;
  }
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const correlationId = correlationFromRequest(req);

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    const expected = env.metaVerifyToken();
    if (mode === 'subscribe' && token && expected && safeEqual(token, expected)) {
      return new Response(challenge ?? '', { status: 200 });
    }
    return jsonResponse(req, { error: 'Forbidden' }, 403);
  }

  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const rawBody = await req.text();
  const metaSecret = env.metaAppSecret();
  if (metaSecret) {
    const sig = req.headers.get('x-hub-signature-256');
    if (!sig) return jsonResponse(req, { error: 'Missing signature' }, 401);
    const valid = await verifyMetaSignature(req, rawBody, metaSecret);
    if (!valid) return jsonResponse(req, { error: 'Invalid signature' }, 401);
  }

  let body: { object?: string; entry?: Array<{ id?: string; changes?: LeadgenChange[] }> };
  try { body = JSON.parse(rawBody); } catch {
    return jsonResponse(req, { error: 'Invalid JSON' }, 400);
  }
  if (body.object !== 'page') {
    log.info('fb_non_page_event_ignored', { fn: 'fb-leadgen-webhook', correlationId, object: body.object });
    return jsonResponse(req, { ok: true, ignored: 'non_page_event' });
  }

  const supabase = getServiceSupabase();
  const allowed = await checkRateLimit(supabase, {
    key: `fbleadgen:${clientIdentifier(req)}`,
    windowSeconds: 60, maxRequests: 120,
  });
  if (!allowed) return jsonResponse(req, { error: 'Rate limit exceeded' }, 429);

  const created: Array<{ leadId: string; leadgenId: string; hydrated: boolean }> = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'leadgen') continue;
      const v = change.value;
      if (!v?.leadgen_id) continue;

      const hydrated = await hydrateLeadgen(v.leadgen_id);
      const fullName = fieldOf(hydrated?.field_data, 'full_name', 'name');
      const phoneRaw = fieldOf(hydrated?.field_data, 'phone_number', 'phone');
      const phone = phoneRaw ? normalizeIsraeliPhone(phoneRaw) : null;
      const email = fieldOf(hydrated?.field_data, 'email');

      const metadata = {
        leadgen_id: v.leadgen_id,
        page_id: v.page_id,
        form_id: v.form_id,
        ad_id: v.ad_id,
        adgroup_id: v.adgroup_id,
        campaign_id: v.campaign_id,
        fb_created_time: v.created_time,
        graph_field_data: hydrated?.field_data ?? null,
        correlation_id: correlationId,
      };

      let leadId: string;
      if (phone || email) {
        const lead = await upsertLead(supabase, {
          phone, email, fullName,
          source: 'facebook_lead_ad',
          intakeChannel: 'form',
          metadata,
        });
        leadId = lead.id;
        // Backfill source_campaign so the Analytics view can attribute later.
        if (v.campaign_id || v.ad_id) {
          await supabase.from('leads').update({
            source_campaign: v.campaign_id ?? null,
            source_detail: v.ad_id ?? null,
          }).eq('id', leadId);
        }
      } else {
        // No contact info available (token missing or hydration failed).
        // Persist a placeholder so the lead isn't lost; operator triage from queue.
        const placeholder = await supabase
          .from('leads')
          .insert({
            full_name: fullName ?? 'ליד פייסבוק (לא הידרציה)',
            source: 'facebook_lead_ad',
            intake_channel: 'form',
            external_source: 'facebook',
            external_id: v.leadgen_id,
            raw_import_snapshot: metadata,
          })
          .select('id')
          .single();
        if (placeholder.error) {
          log.error('fb_placeholder_insert_failed', {
            fn: 'fb-leadgen-webhook', correlationId, err: placeholder.error.message,
          });
          continue;
        }
        leadId = placeholder.data!.id;
        await logLeadEvent(supabase, leadId, 'lead_created', 'system', {
          source: 'facebook_lead_ad', intake_channel: 'form',
          hydration: 'unavailable', correlation_id: correlationId,
        });
      }

      await logLeadEvent(supabase, leadId, 'intake_received', 'system', {
        source: 'facebook_lead_ad', leadgen_id: v.leadgen_id,
        hydrated: !!hydrated, correlation_id: correlationId,
      });

      const queueType = (phone || email) ? 'first_response_due' : 'manual_review_required';
      const reason = (phone || email)
        ? 'ליד חדש מ-Facebook Lead Ad — נדרש מענה ראשוני'
        : 'ליד מ-Facebook Lead Ad ללא פרטי קשר נטענים — נדרש בירור ידני';
      await ensurePendingQueueItem(supabase, {
        leadId, queueType, priorityLevel: 2, reason,
        payloadJson: { leadgen_id: v.leadgen_id, hydrated: !!hydrated, correlationId },
        dueAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      });

      created.push({ leadId, leadgenId: v.leadgen_id, hydrated: !!hydrated });
    }
  }

  log.info('fb_leadgen_processed', { fn: 'fb-leadgen-webhook', correlationId, count: created.length });
  return jsonResponse(req, { ok: true, processed: created.length, correlationId });
});
