import { jsonResponse, preflight } from '../_shared/cors.ts';
import { sendWhatsAppText, sendWhatsAppTemplate } from '../_shared/whatsapp-provider.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { logLeadEvent, transitionLeadStatus, updateLeadFields } from '../_shared/lead-service.ts';
import { getRuntimeConfig } from '../_shared/config-service.ts';
import { runAiDecision } from '../_shared/ai-decision-service.ts';
import { buildTimeContext } from '../_shared/time-context.ts';
import { extractQuestions } from '../_shared/ai-validation.ts';
import { inferPersona } from '../_shared/persona-inference.ts';
import { classifyInbound } from '../_shared/intent-classifier.ts';
import { extractTopicsFromText, mergeTopics, type TopicEntry } from '../_shared/topics.ts';
import { loadProductClaims } from '../_shared/claim-service.ts';
import { releaseConversationLock, tryConversationLock } from '../_shared/conversation-lock.ts';
import { resolveSendMode } from '../_shared/conversation-window.ts';
import { maybeRefreshSummary } from '../_shared/transcript-summary.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { env } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  // Internal endpoint: only accept calls bearing the service-role key.
  if (!verifyBearer(req, env.serviceRoleKey())) {
    return jsonResponse(req, { error: 'Unauthorized' }, 401);
  }

  const correlationId = correlationFromRequest(req);
  const { leadId, conversationId } = await req.json().catch(() => ({}));
  if (!leadId || !conversationId) return jsonResponse(req, { error: 'Missing leadId or conversationId' }, 400);

  const supabase = getServiceSupabase();
  const got = await tryConversationLock(supabase, conversationId);
  if (!got) {
    log.info('orchestrate_lock_busy', { fn: 'orchestrate', correlationId, conversationId });
    return jsonResponse(req, { ok: true, skipped: 'locked' });
  }

  try {
    const config = await getRuntimeConfig(supabase);

    const { data: lead, error: leadErr } = await supabase.from('leads').select('*').eq('id', leadId).single();
    if (leadErr || !lead) return jsonResponse(req, { error: leadErr?.message ?? 'Lead not found' }, 404);

    if (lead.do_not_contact || lead.removed_by_request) {
      log.info('orchestrate_suppressed', { fn: 'orchestrate', correlationId, leadId, reason: 'dnc_or_removed' });
      return jsonResponse(req, { ok: true, skipped: 'suppressed' });
    }

    // Channel-gating: the AI orchestrator currently only owns the WhatsApp
    // channel. Other channels (email, IG DM scraped manually, etc.) get
    // queued for Mia rather than dispatched.
    const { data: conversation, error: convErr } = await supabase
      .from('conversations').select('channel').eq('id', conversationId).single();
    if (convErr) return jsonResponse(req, { error: convErr.message }, 500);
    if (conversation?.channel && conversation.channel !== 'whatsapp') {
      await ensurePendingQueueItem(supabase, {
        leadId, queueType: 'human_handoff', priorityLevel: 2,
        reason: `שיחה בערוץ ${conversation.channel} דורשת מענה ידני`,
        payloadJson: { channel: conversation.channel, correlationId },
      });
      log.info('orchestrate_channel_skipped', {
        fn: 'orchestrate', correlationId, leadId, channel: conversation.channel,
      });
      return jsonResponse(req, { ok: true, skipped: 'non_whatsapp_channel', channel: conversation.channel });
    }

    if (!lead.phone) {
      await ensurePendingQueueItem(supabase, {
        leadId, queueType: 'manual_review_required', priorityLevel: 2,
        reason: 'ליד ללא מספר טלפון, נדרשת בדיקה ידנית',
        payloadJson: { correlationId },
      });
      log.info('orchestrate_no_phone', { fn: 'orchestrate', correlationId, leadId });
      return jsonResponse(req, { ok: true, skipped: 'no_phone' });
    }

    const { data: recentMessages, error: msgErr } = await supabase
      .from('messages')
      .select('sender_type, content_text, created_at, direction')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(8);
    if (msgErr) return jsonResponse(req, { error: msgErr.message }, 500);

    const ordered = (recentMessages ?? []).slice().reverse();
    const freeAdviceCount = ordered.filter((m) => m.sender_type === 'lead' && (m.content_text ?? '').length > 80).length;

    const timeContext = buildTimeContext({
      now: new Date(),
      lastInboundAt: lead.last_inbound_at ?? null,
      activeHours: config.activeHours,
    });

    const recentAiQuestions = Array.from(
      new Set(
        ordered
          .filter((m) => m.sender_type === 'ai')
          .flatMap((m) => extractQuestions(String(m.content_text ?? ''))),
      ),
    ).slice(-6);

    const { data: phoneCalls } = await supabase
      .from('lead_tasks')
      .select('completed_at, payload_json')
      .eq('lead_id', leadId)
      .eq('task_type', 'phone_call_logged')
      .order('completed_at', { ascending: false })
      .limit(20);
    const priorPhoneCallCount = phoneCalls?.length ?? 0;
    const lastPhoneCallOutcome =
      (phoneCalls?.[0]?.payload_json as { outcome?: string } | null)?.outcome ?? null;

    const { data: firstInboundRow } = await supabase
      .from('messages')
      .select('content_text')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'lead')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    const firstInboundSnippet = snippet((firstInboundRow?.content_text as string | null) ?? null, 200);

    const { data: allLeadMessages } = await supabase
      .from('messages')
      .select('content_text')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'lead')
      .order('created_at', { ascending: true })
      .limit(40);
    const personaResult = inferPersona({
      leadMessages: (allLeadMessages ?? []).map((r) => String(r.content_text ?? '')).filter(Boolean),
      source: lead.source ?? null,
    });

    const lastLeadMessage = ordered.filter((m) => m.sender_type === 'lead').slice(-1)[0]?.content_text ?? null;
    const intentSignal = classifyInbound(lastLeadMessage as string | null);

    const authorisedClaims = await loadProductClaims(supabase, config.product.code);

    const decision = await runAiDecision(supabase, {
      lead: {
        id: String(lead.id),
        fullName: lead.full_name,
        phone: lead.phone,
        source: lead.source,
        sourceDetail: lead.source_detail ?? null,
        sourceCampaign: lead.source_campaign ?? null,
        status: lead.lead_status,
        heat: lead.lead_heat,
        score: Number(lead.lead_score ?? 0),
        ownershipMode: lead.ownership_mode,
        paymentStatus: lead.payment_status,
        partnerInvolved: lead.partner_involved === null || lead.partner_involved === undefined
          ? null
          : !!lead.partner_involved,
        doNotContact: !!lead.do_not_contact,
        removedByRequest: !!lead.removed_by_request,
        conversationSummary: lead.conversation_summary,
        lastInboundAt: lead.last_inbound_at,
        lastOutboundAt: lead.last_outbound_at,
        priorPhoneCallCount,
        lastPhoneCallOutcome,
        firstInboundSnippet,
        topicsTouched: Array.isArray(lead.topics_touched) ? (lead.topics_touched as TopicEntry[]) : [],
      },
      recentMessages: ordered.map((m) => ({
        senderType: String(m.sender_type ?? ''),
        contentText: (m.content_text as string | null) ?? null,
        createdAt: String(m.created_at ?? ''),
      })),
      runtimeConfig: config,
      freeAdviceCount,
      timeContext,
      recentAiQuestions,
      personaContext: {
        persona: personaResult.persona,
        guidance: personaResult.guidance,
        signals: personaResult.signals,
      },
      intentContext: {
        intent: intentSignal.intent,
        sentiment: intentSignal.sentiment,
        confidence: intentSignal.confidence,
        matchedKeywords: intentSignal.matchedKeywords,
      },
      authorisedClaims,
    }, correlationId);

    const out = decision.output;
    const desiredMode = out.sendMode;
    const effectiveMode = resolveSendMode(desiredMode, lead.last_inbound_at, config.whatsappSession.freeformWindowHours);

    let sendResult: { ok: boolean; providerMessageId?: string; error?: string } = { ok: false };
    let attemptedSend = false;

    if (out.replyText && (effectiveMode === 'freeform' || effectiveMode === 'template')) {
      attemptedSend = true;
      try {
        if (effectiveMode === 'freeform') {
          sendResult = await sendWhatsAppText(lead.phone as string, out.replyText);
        } else {
          sendResult = await sendWhatsAppTemplate(lead.phone as string, config.whatsappSession.fallbackTemplateName, [
            { name: 'reply', value: out.replyText },
          ]);
        }
      } catch (err) {
        sendResult = { ok: false, error: String(err) };
      }
    }

    if (sendResult.ok && out.replyText) {
      // Persist the AI message; trigger updates lead timestamps.
      await supabase.from('messages').insert({
        conversation_id: conversationId,
        lead_id: leadId,
        provider_message_id: sendResult.providerMessageId ?? null,
        sender_type: 'ai',
        direction: 'outbound',
        message_type: effectiveMode === 'template' ? 'template' : 'text',
        content_text: out.replyText,
        provider_status: 'sent',
      });

      const nextScore = Math.max(0, Math.min(100, Number(lead.lead_score ?? 0) + out.scoreDelta));
      const updates: Record<string, unknown> = { lead_score: nextScore };
      if (out.leadHeatUpdate) updates.lead_heat = out.leadHeatUpdate;
      if (out.nextActionType) updates.next_action_type = out.nextActionType;
      if (out.nextActionDueAt) updates.next_action_due_at = out.nextActionDueAt;
      else updates.next_action_due_at = new Date(Date.now() + config.followUpDelays.firstResponseMinutes * 60_000).toISOString();

      const replyTopics = extractTopicsFromText(out.replyText);
      const inboundTopics = extractTopicsFromText(lastLeadMessage as string | null);
      const combinedTopics = Array.from(new Set([...inboundTopics, ...replyTopics]));
      if (combinedTopics.length) {
        const priorTopics = Array.isArray(lead.topics_touched) ? (lead.topics_touched as TopicEntry[]) : [];
        updates.topics_touched = mergeTopics(priorTopics, combinedTopics);
      }

      await updateLeadFields(supabase, leadId, updates);

      if (out.leadStatusUpdate) {
        await transitionLeadStatus(supabase, leadId, out.leadStatusUpdate, 'ai', `playbook:${out.playbookName}`);
      }

      await logLeadEvent(supabase, leadId, 'ai_reply_sent', 'ai', {
        playbook: out.playbookName,
        score_delta: out.scoreDelta,
        heat_update: out.leadHeatUpdate,
        send_mode: effectiveMode,
        correlation_id: correlationId,
      }, conversationId);
    } else if (attemptedSend && !sendResult.ok) {
      // Send failed → record an integration log + failed_automation queue.
      await supabase.from('integration_logs').insert({
        source: 'whatsapp_outbound',
        status: 'error',
        lead_id: leadId,
        request_data: { reply_text: out.replyText, mode: effectiveMode },
        response_data: { error: sendResult.error ?? null },
        error_message: sendResult.error ?? null,
      });
      await ensurePendingQueueItem(supabase, {
        leadId,
        queueType: 'failed_automation',
        priorityLevel: 1,
        reason: 'WhatsApp outbound failed after retries',
        queueSummary: sendResult.error ?? 'unknown_error',
        payloadJson: { effectiveMode, correlationId },
      });
    }

    if (out.createQueueType) {
      await ensurePendingQueueItem(supabase, {
        leadId,
        queueType: out.createQueueType,
        priorityLevel: out.escalateToPhoneSales ? 1 : 2,
        reason: out.notesForMia ?? 'AI escalation',
        queueSummary: out.replyText ?? null,
        payloadJson: {
          escalate_to_mia: out.escalateToMia,
          escalate_to_phone_sales: out.escalateToPhoneSales,
          playbook: out.playbookName,
        },
      });
    }

    if (out.escalateToMia || out.escalateToPhoneSales) {
      await updateLeadFields(supabase, leadId, {
        ownership_mode: out.escalateToPhoneSales ? 'phone_sales_pending' : 'mia_active',
        requested_phone_call: out.escalateToPhoneSales ? true : !!lead.requested_phone_call,
      });
      const handoffStatus = 'human_handoff';
      await transitionLeadStatus(supabase, leadId, handoffStatus, 'ai', 'orchestrator_handoff');
    }

    // Refresh transcript summary in the background (non-blocking).
    maybeRefreshSummary(supabase, leadId, conversationId).catch((err) =>
      log.error('summary_refresh_failed', { fn: 'orchestrate', correlationId, err: String(err) }),
    );

    log.info('orchestrate_completed', {
      fn: 'orchestrate', correlationId, leadId, conversationId,
      sentOk: sendResult.ok, mode: effectiveMode, status: decision.executionStatus,
      playbook: out.playbookName,
    });

    return jsonResponse(req, {
      ok: true,
      decision: out,
      executionStatus: decision.executionStatus,
      sendResult,
      mode: effectiveMode,
      correlationId,
    });
  } finally {
    await releaseConversationLock(supabase, conversationId);
  }
});

function snippet(text: string | null, maxChars: number): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1)}…`;
}
