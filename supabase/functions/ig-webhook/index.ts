// Instagram DM ingestion webhook.
//
// Meta sends IG DM events to the same shape as Messenger/WhatsApp webhooks:
//   { object: 'instagram', entry: [{ id, time, messaging: [{ sender, recipient, message, timestamp }] }] }
//
// What we do:
//   * GET → Meta verification handshake (echo hub.challenge if verify_token matches META_VERIFY_TOKEN).
//   * POST → verify X-Hub-Signature-256 against META_APP_SECRET, then for each
//     messaging item: dedup-or-create the lead by (external_source='instagram', external_id=sender.id),
//     ensure a conversation with channel='instagram', persist the message,
//     log the lead event, queue first-response if new, fire-and-forget the
//     orchestrator. The orchestrator decides per `runtime_config.ai_enabled_channels`
//     whether to actually reply on this channel — by default IG stays
//     queue-only so a human handles each thread until config is flipped.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensureConversation, logLeadEvent } from '../_shared/lead-service.ts';
import { messageAlreadyLogged } from '../_shared/idempotency.ts';
import { verifyMetaSignature } from '../_shared/webhook-signature.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { env, optional, safeEqual } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { checkRateLimit, clientIdentifier } from '../_shared/rate-limit.ts';

interface IgMessage {
  mid: string;
  text?: string;
  attachments?: Array<{ type: string; payload?: { url?: string } }>;
  is_echo?: boolean;
}
interface IgMessaging {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: IgMessage;
  postback?: { payload?: string; title?: string };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const correlationId = correlationFromRequest(req);

  // ---- 1. Verification handshake -----------------------------------------
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

  // ---- 2. Signature ------------------------------------------------------
  const rawBody = await req.text();
  // Fail-closed: META_APP_SECRET (or WHATSAPP_APP_SECRET fallback) must be
  // set in production. WEBHOOK_ALLOW_UNSIGNED=true is the dev-only opt-out.
  const metaSecret = env.metaAppSecret();
  if (!metaSecret) {
    if (optional('WEBHOOK_ALLOW_UNSIGNED') !== 'true') {
      log.error('ig_webhook_misconfigured', { fn: 'ig-webhook', correlationId });
      return jsonResponse(req, { error: 'Webhook not configured' }, 503);
    }
  } else {
    const sigHeader = req.headers.get('x-hub-signature-256');
    if (!sigHeader) {
      log.warn('ig_signature_missing', { fn: 'ig-webhook', correlationId });
      return jsonResponse(req, { error: 'Missing signature' }, 401);
    }
    const valid = await verifyMetaSignature(req, rawBody, metaSecret);
    if (!valid) {
      log.warn('ig_signature_invalid', { fn: 'ig-webhook', correlationId });
      return jsonResponse(req, { error: 'Invalid signature' }, 401);
    }
  }

  // ---- 3. Parse + rate-limit --------------------------------------------
  let body: { object?: string; entry?: Array<{ id?: string; messaging?: IgMessaging[] }> };
  try { body = JSON.parse(rawBody); } catch {
    return jsonResponse(req, { error: 'Invalid JSON' }, 400);
  }
  if (body.object !== 'instagram') {
    // Meta sometimes routes other product-events to the same URL; ack with 200
    // so they don't retry, but skip processing.
    log.info('ig_non_ig_object_ignored', { fn: 'ig-webhook', correlationId, object: body.object });
    return jsonResponse(req, { ok: true, ignored: 'non_instagram_event' });
  }

  const supabase = getServiceSupabase();
  const allowed = await checkRateLimit(supabase, {
    key: `ig:${clientIdentifier(req)}`,
    windowSeconds: 60,
    maxRequests: 120,
  });
  if (!allowed) return jsonResponse(req, { error: 'Rate limit exceeded' }, 429);

  // ---- 4. Process each message item -------------------------------------
  const results: Array<{ leadId: string; conversationId: string; messageId: string; isNewLead: boolean }> = [];

  for (const entry of body.entry ?? []) {
    for (const m of entry.messaging ?? []) {
      // Skip echoes (our own outbound replays). is_echo on the message is
      // Meta's own out-of-band signal; respect it to avoid loops.
      if (m.message?.is_echo) continue;

      const senderId = m.sender?.id;
      const inboundText = m.message?.text ?? m.postback?.payload ?? null;
      const providerMid = m.message?.mid ?? `postback_${entry.id}_${m.timestamp}`;
      if (!senderId) continue;

      // ---- Dedup-or-create lead by (external_source, external_id) -------
      const existing = await supabase
        .from('leads')
        .select('id')
        .eq('external_source', 'instagram')
        .eq('external_id', senderId)
        .maybeSingle();

      let leadId: string;
      let isNewLead = false;
      if (existing.data?.id) {
        leadId = existing.data.id;
      } else {
        const created = await supabase
          .from('leads')
          .insert({
            full_name: 'ליד אינסטגרם',
            source: 'instagram_dm',
            intake_channel: 'instagram',
            external_source: 'instagram',
            external_id: senderId,
            raw_import_snapshot: { ig_first_message: m, correlation_id: correlationId },
          })
          .select('id')
          .single();
        if (created.error) {
          log.error('ig_lead_create_failed', { fn: 'ig-webhook', correlationId, err: created.error.message });
          continue;
        }
        leadId = created.data!.id;
        isNewLead = true;
        await logLeadEvent(supabase, leadId, 'lead_created', 'system', {
          source: 'instagram_dm', intake_channel: 'instagram', correlation_id: correlationId,
        });
      }

      // ---- Conversation ------------------------------------------------
      const conv = await ensureConversation(supabase, leadId, 'instagram', 'meta_cloud_api');

      // ---- Idempotent message insert ----------------------------------
      const dup = await messageAlreadyLogged(supabase, providerMid);
      if (dup) {
        log.info('ig_message_duplicate', { fn: 'ig-webhook', correlationId, providerMid, leadId });
        continue;
      }

      const inserted = await supabase.from('messages').insert({
        conversation_id: conv.id,
        lead_id: leadId,
        provider_message_id: providerMid,
        sender_type: 'lead',
        direction: 'inbound',
        message_type: m.message?.attachments?.length ? 'media' : 'text',
        content_text: inboundText,
        raw_payload: m,
      }).select('id').single();
      if (inserted.error) {
        log.error('ig_message_insert_failed', { fn: 'ig-webhook', correlationId, err: inserted.error.message });
        continue;
      }

      await logLeadEvent(supabase, leadId, 'inbound_message_received', 'provider', {
        provider: 'meta_cloud_api', channel: 'instagram',
        provider_message_id: providerMid, correlation_id: correlationId,
      }, conv.id);

      if (isNewLead) {
        await ensurePendingQueueItem(supabase, {
          leadId, queueType: 'first_response_due', priorityLevel: 1,
          reason: 'הודעה ראשונה ב-Instagram — נדרש מענה',
          payloadJson: { channel: 'instagram', correlationId },
          dueAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
      }

      // Fire-and-forget the orchestrator. It checks ai_enabled_channels and
      // skips IG by default until the operator opts in.
      const orchestrateUrl = `${env.supabaseUrl()}/functions/v1/orchestrate-message`;
      fetch(orchestrateUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.serviceRoleKey()}`,
          'Content-Type': 'application/json',
          'x-correlation-id': correlationId,
        },
        body: JSON.stringify({ leadId, conversationId: conv.id }),
      }).catch((err) => log.error('ig_orchestrate_dispatch_failed', { fn: 'ig-webhook', correlationId, err: String(err) }));

      results.push({ leadId, conversationId: conv.id, messageId: inserted.data!.id, isNewLead });
    }
  }

  log.info('ig_inbound_accepted', { fn: 'ig-webhook', correlationId, count: results.length });
  return jsonResponse(req, { ok: true, processed: results.length, correlationId });
});
