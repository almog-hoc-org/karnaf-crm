import { jsonResponse, preflight } from '../_shared/cors.ts';
import { normalizeIsraeliPhone } from '../_shared/phone.ts';
import { normalizeProviderInbound, sendWhatsAppText } from '../_shared/whatsapp-provider.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensureConversation, logLeadEvent, updateLeadFields, upsertLeadByPhone } from '../_shared/lead-service.ts';
import { messageAlreadyLogged } from '../_shared/idempotency.ts';
import { verifyMetaSignature } from '../_shared/webhook-signature.ts';
import { env, optional, safeEqual } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { checkRateLimit, clientIdentifier } from '../_shared/rate-limit.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { archiveWhatsAppMedia } from '../_shared/media-fetch.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const correlationId = correlationFromRequest(req);

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token && safeEqual(token, env.whatsappVerifyToken())) {
      return new Response(challenge ?? '', { status: 200 });
    }
    return jsonResponse(req, { error: 'Forbidden' }, 403);
  }

  if (req.method !== 'POST') {
    return jsonResponse(req, { error: 'Method not allowed' }, 405);
  }

  const rawBody = await req.text();

  // Fail-closed: WHATSAPP_APP_SECRET must be set in production. Previously
  // an unset secret silently accepted unsigned bodies — anyone with the URL
  // could inject inbound messages. WEBHOOK_ALLOW_UNSIGNED=true is the
  // explicit dev-only opt-out.
  const metaSecret = env.whatsappAppSecret();
  if (!metaSecret) {
    if (optional('WEBHOOK_ALLOW_UNSIGNED') !== 'true') {
      log.error('whatsapp_webhook_misconfigured', { fn: 'whatsapp-webhook', correlationId });
      return jsonResponse(req, { error: 'Webhook not configured' }, 503);
    }
  } else {
    const sigHeader = req.headers.get('x-hub-signature-256');
    if (!sigHeader) {
      log.warn('whatsapp_signature_missing', { fn: 'whatsapp-webhook', correlationId });
      return jsonResponse(req, { error: 'Missing signature' }, 401);
    }
    const valid = await verifyMetaSignature(req, rawBody, metaSecret);
    if (!valid) {
      log.warn('whatsapp_signature_invalid', { fn: 'whatsapp-webhook', correlationId });
      return jsonResponse(req, { error: 'Invalid signature' }, 401);
    }
  }

  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody); } catch {
    return jsonResponse(req, { error: 'Invalid JSON' }, 400);
  }

  const normalized = normalizeProviderInbound(body);
  if (!normalized) {
    return jsonResponse(req, { ok: true, skipped: true, reason: 'unsupported_payload' });
  }

  const supabase = getServiceSupabase();

  const allowed = await checkRateLimit(supabase, {
    key: `whatsapp:${clientIdentifier(req)}`,
    windowSeconds: 60,
    maxRequests: 120,
  });
  if (!allowed) {
    log.warn('rate_limited', { fn: 'whatsapp-webhook', correlationId, ip: clientIdentifier(req) });
    return jsonResponse(req, { error: 'Rate limit exceeded' }, 429);
  }

  if (await messageAlreadyLogged(supabase, normalized.providerMessageId)) {
    return jsonResponse(req, { ok: true, skipped: true, reason: 'duplicate_provider_message_id' });
  }

  const phone = normalizeIsraeliPhone(normalized.phone) || normalized.phone;
  const lead = await upsertLeadByPhone(supabase, {
    phone,
    senderName: normalized.senderName,
    source: 'whatsapp',
    intakeChannel: 'whatsapp',
  });
  const conversation = await ensureConversation(supabase, lead.id, 'whatsapp', normalized.provider);

  // Insert the inbound message; relies on trigger sync_lead_message_timestamps
  // to update lead.last_message_at + last_inbound_at atomically.
  const { data: insertedMsg, error: msgErr } = await supabase.from('messages').insert({
    conversation_id: conversation.id,
    lead_id: lead.id,
    provider_message_id: normalized.providerMessageId,
    sender_type: 'lead',
    sender_name: normalized.senderName,
    direction: 'inbound',
    message_type: normalized.messageType === 'unknown' ? 'text' : normalized.messageType,
    content_text: normalized.text,
    media_type: normalized.mediaType ?? null,
    created_at: normalized.receivedAt,
    raw_payload: normalized.rawPayload,
  }).select('id').single();
  // Conflict on the unique provider_message_id index = duplicate that beat
  // our pre-check. Treat as no-op success.
  if (msgErr && !String(msgErr.message || '').includes('duplicate key value')) {
    log.error('inbound_insert_failed', { fn: 'whatsapp-webhook', correlationId, err: String(msgErr) });
    return jsonResponse(req, { error: 'Failed to log inbound message' }, 500);
  }

  // Archive WhatsApp media (image/audio/video/document) to private storage
  // out-of-band. Failures are logged but never break the webhook contract.
  if (insertedMsg?.id && normalized.messageType === 'media') {
    archiveWhatsAppMedia(supabase, {
      messageId: insertedMsg.id as string,
      providerMessageId: normalized.providerMessageId,
      rawPayload: normalized.rawPayload,
      conversationId: conversation.id,
    }, correlationId).catch((err) =>
      log.error('media_archive_failed', { fn: 'whatsapp-webhook', correlationId, err: String(err) }),
    );
  }

  const eventRow = await logLeadEvent(supabase, lead.id, 'inbound_message_received', 'provider', {
    provider: normalized.provider,
    provider_message_id: normalized.providerMessageId,
    correlation_id: correlationId,
  }, conversation.id);

  const flushedManualReplies = await flushPendingManualReplies(supabase, {
    leadId: lead.id,
    conversationId: conversation.id,
    phone,
    correlationId,
  });

  if (flushedManualReplies > 0) {
    log.info('pending_manual_replies_flushed', {
      fn: 'whatsapp-webhook', correlationId, leadId: lead.id, conversationId: conversation.id, count: flushedManualReplies,
    });
    return jsonResponse(req, {
      ok: true,
      leadId: lead.id,
      conversationId: conversation.id,
      correlationId,
      flushedManualReplies,
      skippedAi: true,
    });
  }

  const routed = await handleWhatsAppRouter(supabase, {
    leadId: lead.id,
    conversationId: conversation.id,
    phone,
    text: normalized.text,
    correlationId,
    hasTrack: !!lead.primary_track,
  });
  if (routed.handled) {
    log.info('whatsapp_router_handled', {
      fn: 'whatsapp-webhook', correlationId, leadId: lead.id, action: routed.action,
    });
    return jsonResponse(req, {
      ok: true,
      leadId: lead.id,
      conversationId: conversation.id,
      correlationId,
      routerAction: routed.action,
      skippedAi: true,
    });
  }

  // Enqueue an orchestrate-message dispatch instead of fire-and-forget so
  // a crashed orchestrator or network glitch doesn't silently drop the
  // reply. dispatch-outbound (run every minute by pg_cron) drains the
  // queue with bounded retries + a dead-letter shelf.
  const { error: dispatchErr } = await supabase.from('outbound_dispatch').insert({
    lead_id: lead.id,
    conversation_id: conversation.id,
    source_event_id: eventRow?.id ?? null,
    correlation_id: correlationId,
    payload: {
      provider: normalized.provider,
      provider_message_id: normalized.providerMessageId,
    },
  });
  // Unique on source_event_id means a retry of the same webhook will
  // collide here — treat that as a no-op success.
  if (dispatchErr && !String(dispatchErr.message || '').includes('duplicate key value')) {
    log.error('dispatch_enqueue_failed', {
      fn: 'whatsapp-webhook', correlationId, leadId: lead.id, err: String(dispatchErr),
    });
    await ensurePendingQueueItem(supabase, {
      leadId: lead.id,
      queueType: 'failed_automation',
      priorityLevel: 1,
      reason: 'WhatsApp dispatch queue insert failed before the AI reply could be scheduled',
      queueSummary: String(dispatchErr),
      payloadJson: {
        correlationId,
        provider: normalized.provider,
        providerMessageId: normalized.providerMessageId,
        sourceEventId: eventRow?.id ?? null,
      },
      createdByActorType: 'system',
    });
  }

  log.info('inbound_accepted', { fn: 'whatsapp-webhook', correlationId, leadId: lead.id, conversationId: conversation.id });
  return jsonResponse(req, { ok: true, leadId: lead.id, conversationId: conversation.id, correlationId });
});

async function flushPendingManualReplies(
  supabase: ReturnType<typeof getServiceSupabase>,
  input: { leadId: string; conversationId: string; phone: string; correlationId: string },
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
    const result = await sendWhatsAppText(input.phone, row.text);
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
        reason: 'Pending manual reply failed after customer reopened WhatsApp window',
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

async function handleWhatsAppRouter(
  supabase: ReturnType<typeof getServiceSupabase>,
  input: { leadId: string; conversationId: string; phone: string; text: string | null; correlationId: string; hasTrack: boolean },
): Promise<{ handled: boolean; action?: string }> {
  if (input.hasTrack) return { handled: false };

  const text = (input.text ?? '').trim().toLowerCase();
  const { data: options, error: optionsErr } = await supabase
    .from('whatsapp_router_options')
    .select('option_key, display_order, label_he, match_terms, track, stage, interest_topic, presale_project')
    .eq('is_active', true)
    .order('display_order', { ascending: true });
  if (optionsErr || !options?.length) return { handled: false };

  const matched = text ? matchRouterOption(text, options as RouterOption[]) : null;
  if (matched) {
    if (matched.track === 'human') {
      await updateLeadFields(supabase, input.leadId, {
        ownership_mode: 'mia_active',
        primary_track: null,
        interest_topic: matched.interest_topic ?? 'נציג אנושי',
      });
      await supabase.from('whatsapp_router_state').upsert({
        lead_id: input.leadId,
        conversation_id: input.conversationId,
        status: 'human_requested',
        selected_option_key: matched.option_key,
        selected_at: new Date().toISOString(),
        metadata: { correlationId: input.correlationId, text },
      }, { onConflict: 'lead_id' });
      await ensurePendingQueueItem(supabase, {
        leadId: input.leadId,
        queueType: 'whatsapp_human_requested',
        priorityLevel: 1,
        reason: 'לקוח ביקש מעבר לנציג אנושי בוואטסאפ',
        queueSummary: input.text,
        payloadJson: { correlationId: input.correlationId, optionKey: matched.option_key },
      });
      await logLeadEvent(supabase, input.leadId, 'whatsapp_router_human_requested', 'system', {
        correlation_id: input.correlationId,
        option_key: matched.option_key,
        text: input.text,
      }, input.conversationId);
      await sendRouterText(supabase, input, 'מעולה, העברתי לנציג אנושי. נחזור אליך כאן בהקדם.');
      return { handled: true, action: 'human_requested' };
    }

    await routeLeadToOption(supabase, input, matched);
    await sendRouterText(
      supabase,
      input,
      `קיבלתי — סימנתי אותך למסלול ${matched.label_he}. נמשיך מכאן עם הפרטים הרלוונטיים.`,
    );
    return { handled: true, action: `routed:${matched.option_key}` };
  }

  const { data: state } = await supabase
    .from('whatsapp_router_state')
    .select('status, last_prompted_at')
    .eq('lead_id', input.leadId)
    .maybeSingle();

  if (!state || state.status === 'awaiting_topic') {
    const promptedRecently = state?.last_prompted_at && Date.now() - new Date(state.last_prompted_at as string).getTime() < 30 * 60 * 1000;
    if (!promptedRecently) {
      await supabase.from('whatsapp_router_state').upsert({
        lead_id: input.leadId,
        conversation_id: input.conversationId,
        status: 'awaiting_topic',
        last_prompted_at: new Date().toISOString(),
        metadata: { correlationId: input.correlationId },
      }, { onConflict: 'lead_id' });
      await ensurePendingQueueItem(supabase, {
        leadId: input.leadId,
        queueType: 'whatsapp_topic_unselected',
        priorityLevel: 2,
        reason: 'לקוח נכנס מוואטסאפ ועדיין לא בחר נושא',
        queueSummary: input.text,
        dueAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        payloadJson: { correlationId: input.correlationId },
      });
      await logLeadEvent(supabase, input.leadId, 'whatsapp_router_prompted', 'system', {
        correlation_id: input.correlationId,
      }, input.conversationId);
      await sendRouterText(supabase, input, buildRouterPrompt(options as RouterOption[]));
      return { handled: true, action: 'prompted' };
    }
    return { handled: true, action: 'awaiting_topic' };
  }

  return { handled: false };
}

interface RouterOption {
  option_key: string;
  display_order: number;
  label_he: string;
  match_terms: string[];
  track: string;
  stage: string | null;
  interest_topic: string | null;
  presale_project: string | null;
}

function matchRouterOption(text: string, options: RouterOption[]): RouterOption | null {
  return options.find((option) =>
    option.match_terms.some((term) => {
      const t = String(term).trim().toLowerCase();
      return t && (text === t || text.includes(t));
    })
  ) ?? null;
}

function buildRouterPrompt(options: RouterOption[]): string {
  const lines = options.map((option, idx) => `${idx + 1}. ${option.label_he}`);
  return `היי, באיזה נושא תרצה/י עזרה?\n${lines.join('\n')}\nאפשר לענות במספר או במילים.`;
}

async function routeLeadToOption(
  supabase: ReturnType<typeof getServiceSupabase>,
  input: { leadId: string; conversationId: string; text: string | null; correlationId: string },
  option: RouterOption,
) {
  const activeTracks = [option.track];
  await updateLeadFields(supabase, input.leadId, {
    primary_track: option.track,
    active_tracks: activeTracks,
    interest_topic: option.interest_topic ?? option.label_he,
    ownership_mode: option.track === 'presale' || option.track === 'investor_mentorship' ? 'mia_active' : 'ai_active',
  });

  const { data: existingDeal } = await supabase
    .from('deals')
    .select('id')
    .eq('lead_id', input.leadId)
    .eq('track', option.track)
    .eq('status', 'open')
    .maybeSingle();
  const dealPatch = {
    stage: option.stage ?? 'new',
    source: 'whatsapp_router',
    presale_project: option.presale_project,
    metadata: { optionKey: option.option_key, correlationId: input.correlationId, text: input.text },
  };
  if (existingDeal?.id) {
    await supabase.from('deals').update(dealPatch).eq('id', existingDeal.id);
  } else {
    await supabase.from('deals').insert({
      lead_id: input.leadId,
      track: option.track,
      status: 'open',
      ...dealPatch,
    });
  }

  await supabase.from('whatsapp_router_state').upsert({
    lead_id: input.leadId,
    conversation_id: input.conversationId,
    status: 'routed',
    selected_option_key: option.option_key,
    selected_at: new Date().toISOString(),
    metadata: { correlationId: input.correlationId, text: input.text },
  }, { onConflict: 'lead_id' });

  if (option.track === 'presale' || option.track === 'investor_mentorship') {
    await ensurePendingQueueItem(supabase, {
      leadId: input.leadId,
      queueType: option.track === 'presale' ? 'presale_followup_due' : 'investor_followup_due',
      priorityLevel: 1,
      reason: option.track === 'presale' ? 'ליד פריסייל חדש מוואטסאפ' : 'ליד ליווי משקיעים חדש מוואטסאפ',
      queueSummary: input.text,
      dueAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      payloadJson: { correlationId: input.correlationId, optionKey: option.option_key },
    });
  }

  await logLeadEvent(supabase, input.leadId, 'whatsapp_router_routed', 'system', {
    correlation_id: input.correlationId,
    option_key: option.option_key,
    track: option.track,
    stage: option.stage,
  }, input.conversationId);
}

async function sendRouterText(
  supabase: ReturnType<typeof getServiceSupabase>,
  input: { leadId: string; conversationId: string; phone: string; correlationId: string },
  text: string,
) {
  const result = await sendWhatsAppText(input.phone, text);
  await supabase.from('messages').insert({
    conversation_id: input.conversationId,
    lead_id: input.leadId,
    provider_message_id: result.providerMessageId ?? null,
    sender_type: 'system',
    sender_name: 'Karnaf Router',
    direction: 'outbound',
    message_type: 'text',
    content_text: text,
    provider_status: result.ok ? 'sent' : 'failed',
    provider_error: result.ok ? null : result.error ?? 'send failed',
    raw_payload: { source: 'whatsapp_router', correlation_id: input.correlationId },
  });
}
