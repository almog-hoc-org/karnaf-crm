// Tier 8.A — Instagram DM inbound webhook (Meta Graph, object='instagram').
//
// Mirrors whatsapp-webhook's skeleton minus the topic router (a WhatsApp
// concept): verify handshake → signature → rate limit → normalize →
// idempotency on mid → upsert lead by IGSID → log message → flush
// pending manual replies → enqueue orchestrate dispatch. The AI bot
// then replies in the DM through the same orchestrate pipeline as
// WhatsApp, with channel-aware window semantics (no template fallback
// on Instagram — outside 24h replies queue as pending_manual_replies).
//
// Identity: IGSID only. Leads created here have no phone; when the bot
// learns one, the operator merges via merge_leads (083).

import { jsonResponse, preflight } from '../_shared/cors.ts';
import {
  igEnv,
  normalizeInstagramInbound,
  sendInstagramText,
} from '../_shared/instagram-provider.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensureConversation, logLeadEvent } from '../_shared/lead-service.ts';
import { messageAlreadyLogged } from '../_shared/idempotency.ts';
import { verifyMetaSignature } from '../_shared/webhook-signature.ts';
import { optional, safeEqual } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { checkRateLimit, clientIdentifier } from '../_shared/rate-limit.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const correlationId = correlationFromRequest(req);

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token && igEnv.verifyToken() && safeEqual(token, igEnv.verifyToken())) {
      return new Response(challenge ?? '', { status: 200 });
    }
    return jsonResponse(req, { error: 'Forbidden' }, 403);
  }

  if (req.method !== 'POST') {
    return jsonResponse(req, { error: 'Method not allowed' }, 405);
  }

  const rawBody = await req.text();

  // Fail-closed signature check, same posture as whatsapp-webhook.
  const appSecret = igEnv.appSecret();
  if (!appSecret) {
    if (optional('WEBHOOK_ALLOW_UNSIGNED') !== 'true') {
      log.error('instagram_webhook_misconfigured', { fn: 'instagram-webhook', correlationId });
      return jsonResponse(req, { error: 'Webhook not configured' }, 503);
    }
  } else {
    const sigHeader = req.headers.get('x-hub-signature-256');
    if (!sigHeader) {
      log.warn('instagram_signature_missing', { fn: 'instagram-webhook', correlationId });
      return jsonResponse(req, { error: 'Missing signature' }, 401);
    }
    const valid = await verifyMetaSignature(req, rawBody, appSecret);
    if (!valid) {
      log.warn('instagram_signature_invalid', { fn: 'instagram-webhook', correlationId });
      return jsonResponse(req, { error: 'Invalid signature' }, 401);
    }
  }

  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody); } catch {
    return jsonResponse(req, { error: 'Invalid JSON' }, 400);
  }

  const messages = normalizeInstagramInbound(body);
  if (messages.length === 0) {
    // Echoes, read receipts, non-messaging entries — ack so Meta stops retrying.
    return jsonResponse(req, { ok: true, skipped: true, reason: 'no_inbound_messages' });
  }

  const supabase = getServiceSupabase();

  const allowed = await checkRateLimit(supabase, {
    key: `instagram:${clientIdentifier(req)}`,
    windowSeconds: 60,
    maxRequests: 120,
  });
  if (!allowed) {
    log.warn('rate_limited', { fn: 'instagram-webhook', correlationId, ip: clientIdentifier(req) });
    return jsonResponse(req, { error: 'Rate limit exceeded' }, 429);
  }

  const results: Array<Record<string, unknown>> = [];

  for (const normalized of messages) {
    if (await messageAlreadyLogged(supabase, normalized.providerMessageId)) {
      results.push({ skipped: true, reason: 'duplicate_provider_message_id' });
      continue;
    }

    const { data: lead, error: leadErr } = await supabase.rpc('upsert_lead_by_igsid', {
      p_igsid: normalized.igsid,
      p_full_name: null,
      p_username: null,
      p_metadata: { correlation_id: correlationId },
    });
    if (leadErr || !lead) {
      log.error('ig_lead_upsert_failed', { fn: 'instagram-webhook', correlationId, err: String(leadErr?.message) });
      return jsonResponse(req, { error: 'Failed to upsert lead' }, 500);
    }
    const leadRow = lead as { id: string; created_at: string };

    const conversation = await ensureConversation(supabase, leadRow.id, 'instagram', 'instagram_graph');

    const { error: msgErr } = await supabase.from('messages').insert({
      conversation_id: conversation.id,
      lead_id: leadRow.id,
      provider_message_id: normalized.providerMessageId,
      sender_type: 'lead',
      direction: 'inbound',
      message_type: normalized.messageType === 'unknown' ? 'text' : normalized.messageType,
      content_text: normalized.text,
      media_type: normalized.mediaType ?? null,
      created_at: normalized.receivedAt,
      raw_payload: normalized.rawPayload,
    });
    if (msgErr && !String(msgErr.message || '').includes('duplicate key value')) {
      log.error('ig_inbound_insert_failed', { fn: 'instagram-webhook', correlationId, err: String(msgErr) });
      return jsonResponse(req, { error: 'Failed to log inbound message' }, 500);
    }

    const eventRow = await logLeadEvent(supabase, leadRow.id, 'inbound_message_received', 'provider', {
      provider: 'instagram_graph',
      provider_message_id: normalized.providerMessageId,
      correlation_id: correlationId,
    }, conversation.id);

    // First inbound from a brand-new lead → first-response SLA (30min,
    // priority 1 — same treatment leads-intake gives instagram_dm).
    const isNewLead = Date.now() - Date.parse(leadRow.created_at) < 60_000;
    if (isNewLead) {
      await ensurePendingQueueItem(supabase, {
        leadId: leadRow.id,
        queueType: 'first_response_due',
        priorityLevel: 1,
        reason: 'ליד חדש מאינסטגרם — מענה ראשון',
        dueAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        createdByActorType: 'system',
      });
    }

    // Customer inbound reopened the 24h window — flush queued manual replies.
    const flushed = await flushPendingManualReplies(supabase, {
      leadId: leadRow.id,
      conversationId: conversation.id,
      igsid: normalized.igsid,
      correlationId,
    });
    if (flushed > 0) {
      log.info('ig_pending_manual_replies_flushed', {
        fn: 'instagram-webhook', correlationId, leadId: leadRow.id, count: flushed,
      });
      results.push({ leadId: leadRow.id, flushedManualReplies: flushed, skippedAi: true });
      continue;
    }

    const { error: dispatchErr } = await supabase.from('outbound_dispatch').insert({
      lead_id: leadRow.id,
      conversation_id: conversation.id,
      source_event_id: eventRow?.id ?? null,
      correlation_id: correlationId,
      payload: {
        provider: 'instagram_graph',
        provider_message_id: normalized.providerMessageId,
      },
    });
    if (dispatchErr && !String(dispatchErr.message || '').includes('duplicate key value')) {
      log.error('ig_dispatch_enqueue_failed', { fn: 'instagram-webhook', correlationId, leadId: leadRow.id, err: String(dispatchErr) });
      await ensurePendingQueueItem(supabase, {
        leadId: leadRow.id,
        queueType: 'failed_automation',
        priorityLevel: 1,
        reason: 'Instagram dispatch queue insert failed before the AI reply could be scheduled',
        queueSummary: String(dispatchErr),
        payloadJson: { correlationId, providerMessageId: normalized.providerMessageId },
        createdByActorType: 'system',
      });
    }

    results.push({ leadId: leadRow.id, conversationId: conversation.id });
  }

  log.info('ig_inbound_accepted', { fn: 'instagram-webhook', correlationId, processed: results.length });
  return jsonResponse(req, { ok: true, correlationId, results });
});

async function flushPendingManualReplies(
  supabase: ReturnType<typeof getServiceSupabase>,
  input: { leadId: string; conversationId: string; igsid: string; correlationId: string },
): Promise<number> {
  const { data: pending, error } = await supabase
    .from('pending_manual_replies')
    .select('id, text, sender_type, sender_name')
    .eq('lead_id', input.leadId)
    .eq('conversation_id', input.conversationId)
    .in('status', ['queued', 'reopen_sent', 'failed'])
    .order('queued_at', { ascending: true })
    .limit(5);

  if (error || !pending?.length) return 0;

  let sent = 0;
  for (const row of pending as Array<{ id: string; text: string; sender_type: string; sender_name: string | null }>) {
    const result = await sendInstagramText(input.igsid, row.text);
    if (!result.ok) {
      await supabase.from('pending_manual_replies').update({
        status: 'failed',
        last_error: result.error ?? 'Send failed after inbound reopened window',
        failed_at: new Date().toISOString(),
      }).eq('id', row.id);
      await ensurePendingQueueItem(supabase, {
        leadId: input.leadId,
        queueType: 'failed_automation',
        priorityLevel: 1,
        reason: 'Pending manual reply failed after customer reopened Instagram window',
        queueSummary: result.error ?? 'Send failed',
        payloadJson: { pendingReplyId: row.id, correlationId: input.correlationId },
        createdByActorType: 'system',
      });
      continue;
    }

    await supabase.from('messages').insert({
      conversation_id: input.conversationId,
      lead_id: input.leadId,
      provider_message_id: result.providerMessageId ?? null,
      sender_type: row.sender_type,
      sender_name: row.sender_name,
      direction: 'outbound',
      message_type: 'text',
      content_text: row.text,
      provider_status: 'sent',
      raw_payload: { source: 'pending_manual_reply', pending_reply_id: row.id, correlation_id: input.correlationId },
    });

    await supabase.from('pending_manual_replies').update({
      status: 'sent',
      send_provider_message_id: result.providerMessageId ?? null,
      sent_at: new Date().toISOString(),
      last_error: null,
    }).eq('id', row.id);

    await logLeadEvent(supabase, input.leadId, 'pending_manual_reply_sent', 'system', {
      correlation_id: input.correlationId,
      pending_reply_id: row.id,
      provider_message_id: result.providerMessageId ?? null,
    }, input.conversationId);
    sent += 1;
  }
  return sent;
}
