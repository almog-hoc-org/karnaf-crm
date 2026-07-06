import { jsonResponse, preflight } from '../_shared/cors.ts';
import { sendWhatsAppText, sendWhatsAppTemplate } from '../_shared/whatsapp-provider.ts';
import { sendInstagramText } from '../_shared/instagram-provider.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { logLeadEvent, transitionLeadStatus, updateLeadFields } from '../_shared/lead-service.ts';
import { getRuntimeConfig } from '../_shared/config-service.ts';
import { runAiDecision } from '../_shared/ai-decision-service.ts';
import { buildTimeContext } from '../_shared/time-context.ts';
import { extractQuestions } from '../_shared/ai-validation.ts';
import { inferPersona } from '../_shared/persona-inference.ts';
import { classifyInbound } from '../_shared/intent-classifier.ts';
import { classifyLeadIntake } from '../_shared/lead-classifier.ts';
import { extractTopicsFromText, mergeTopics, type TopicEntry } from '../_shared/topics.ts';
import { loadProductClaims } from '../_shared/claim-service.ts';
import { releaseConversationLock, tryConversationLock } from '../_shared/conversation-lock.ts';
import { fallbackTemplateParams, isTemplateConfigError } from '../_shared/provider-errors.ts';
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
  if (!leadId || !conversationId)
    return jsonResponse(req, { error: 'Missing leadId or conversationId' }, 400);

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
      log.info('orchestrate_suppressed', {
        fn: 'orchestrate',
        correlationId,
        leadId,
        reason: 'dnc_or_removed',
      });
      return jsonResponse(req, { ok: true, skipped: 'suppressed' });
    }

    log.info('orchestrate_ownership_seen', {
      fn: 'orchestrate',
      correlationId,
      leadId,
      ownership_mode: lead.ownership_mode,
      lead_status: lead.lead_status,
    });

    // Channel-gating: the AI orchestrator owns WhatsApp + Instagram
    // (Tier 8.A). Other channels (email, manual) get queued for Mia
    // rather than dispatched.
    const { data: conversation, error: convErr } = await supabase
      .from('conversations')
      .select('channel')
      .eq('id', conversationId)
      .single();
    if (convErr) return jsonResponse(req, { error: convErr.message }, 500);
    const channel: string = conversation?.channel ?? 'whatsapp';
    if (channel !== 'whatsapp' && channel !== 'instagram') {
      await ensurePendingQueueItem(supabase, {
        leadId,
        queueType: 'human_handoff',
        priorityLevel: 2,
        reason: `שיחה בערוץ ${channel} דורשת מענה ידני`,
        payloadJson: { channel, correlationId },
      });
      log.info('orchestrate_channel_skipped', {
        fn: 'orchestrate',
        correlationId,
        leadId,
        channel,
      });
      return jsonResponse(req, { ok: true, skipped: 'unsupported_channel', channel });
    }

    // Identity guard is channel-specific: WhatsApp needs a phone,
    // Instagram needs an IGSID.
    const missingIdentity = channel === 'whatsapp' ? !lead.phone : !lead.ig_user_id;
    if (missingIdentity) {
      await ensurePendingQueueItem(supabase, {
        leadId,
        queueType: 'manual_review_required',
        priorityLevel: 2,
        reason: channel === 'whatsapp'
          ? 'ליד ללא מספר טלפון, נדרשת בדיקה ידנית'
          : 'ליד אינסטגרם ללא מזהה שיחה, נדרשת בדיקה ידנית',
        payloadJson: { correlationId, channel },
      });
      log.info('orchestrate_no_identity', { fn: 'orchestrate', correlationId, leadId, channel });
      return jsonResponse(req, { ok: true, skipped: 'no_identity' });
    }

    if (lead.ownership_mode !== 'ai_active') {
      const queueType = lead.ownership_mode === 'phone_sales_pending' ? 'phone_escalation' : 'human_handoff';
      await ensurePendingQueueItem(supabase, {
        leadId,
        queueType,
        priorityLevel: lead.ownership_mode === 'phone_sales_pending' ? 1 : 2,
        reason: `AI suppressed: lead ownership is ${lead.ownership_mode}`,
        payloadJson: { ownership_mode: lead.ownership_mode, lead_status: lead.lead_status, correlationId },
        createdByActorType: 'system',
      });
      await logLeadEvent(
        supabase,
        leadId,
        'ai_suppressed_human_owner',
        'system',
        {
          ownership_mode: lead.ownership_mode,
          lead_status: lead.lead_status,
          correlation_id: correlationId,
        },
        conversationId,
      );
      log.info('orchestrate_ai_suppressed_by_owner', {
        fn: 'orchestrate',
        correlationId,
        leadId,
        ownership_mode: lead.ownership_mode,
      });
      return jsonResponse(req, { ok: true, skipped: 'non_ai_owner', ownershipMode: lead.ownership_mode });
    }

    // Program members are served by the deterministic concierge in
    // whatsapp-webhook — the LLM never speaks to a paying member. This
    // guard covers the paths that bypass the webhook: return_to_ai's
    // direct POST and stale outbound_dispatch retries. It also means
    // "return to AI" on a member = return to concierge (next inbound
    // greets again), with no extra wiring.
    const { data: memberRow } = await supabase
      .from('program_members')
      .select('lead_id')
      .eq('lead_id', leadId)
      .maybeSingle();
    if (memberRow) {
      log.info('orchestrate_member_skip', { fn: 'orchestrate', correlationId, leadId });
      return jsonResponse(req, { ok: true, skipped: 'program_member' });
    }

    const { data: recentMessages, error: msgErr } = await supabase
      .from('messages')
      .select('sender_type, content_text, created_at, direction')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(8);
    if (msgErr) return jsonResponse(req, { error: msgErr.message }, 500);

    const ordered = (recentMessages ?? []).slice().reverse();

    // Coalescing / anti-double-send guard. orchestrate always answers the
    // LATEST lead message with full recent context. If the most recent message
    // is already outbound, this lead has nothing unanswered — this dispatch is
    // a duplicate or was superseded by a turn that already replied (e.g. two
    // inbound messages a few seconds apart each enqueued a dispatch). The
    // conversation lock guarantees the earlier turn's reply is committed before
    // we get here, so rapid-fire messages collapse into a single reply instead
    // of producing two (often contradictory) sends.
    const latestMessage = ordered[ordered.length - 1];
    if (latestMessage && latestMessage.direction === 'outbound') {
      log.info('orchestrate_already_answered', {
        fn: 'orchestrate',
        correlationId,
        leadId,
        conversationId,
        latestSender: latestMessage.sender_type,
      });
      return jsonResponse(req, { ok: true, skipped: 'already_answered' });
    }

    const freeAdviceCount = ordered.filter(
      (m) => m.sender_type === 'lead' && (m.content_text ?? '').length > 80,
    ).length;

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

    const lastLeadMessage =
      ordered.filter((m) => m.sender_type === 'lead').slice(-1)[0]?.content_text ?? null;
    const intentSignal = classifyInbound(lastLeadMessage as string | null);
    const leadClassification = classifyLeadIntake({
      source: lead.source ?? null,
      sourceDetail: lead.source_detail ?? null,
      sourceCampaign: lead.source_campaign ?? null,
      firstMessage: firstInboundSnippet,
      latestMessage: lastLeadMessage as string | null,
      metadata: (lead.raw_import_snapshot as Record<string, unknown> | null) ?? null,
    });

    // Track stickiness: once a specific track is known it must not be lost when a
    // later message reclassifies (e.g. "פגישות ייעוץ" → consultation → flagship).
    const SPECIFIC_INTERESTS = new Set(['investor_mentorship', 'mentorship', 'contractor_group_purchase']);
    const trackFromInterest = (pi: string | null | undefined): string | null =>
      pi === 'investor_mentorship' || pi === 'mentorship'
        ? 'investor_mentorship'
        : pi === 'contractor_group_purchase'
          ? 'presale'
          : null;
    // Don't downgrade an established specific product_interest to a generic one.
    const effectiveProductInterest =
      SPECIFIC_INTERESTS.has(String(lead.product_interest)) && !SPECIFIC_INTERESTS.has(leadClassification.productInterest)
        ? (lead.product_interest as string)
        : leadClassification.productInterest;
    // Persist primary_track when a specific track is newly detected and none is set.
    const persistTrack = !lead.primary_track ? trackFromInterest(effectiveProductInterest) : null;
    const effectiveTrack = (lead.primary_track as string | null) ?? persistTrack;

    await updateLeadFields(supabase, leadId, {
      inquiry_type: leadClassification.inquiryType,
      product_interest: effectiveProductInterest,
      intake_segment: leadClassification.intakeSegment,
      classification_confidence: leadClassification.confidence,
      classification_summary: leadClassification.operatorSummary,
      suggested_next_action: leadClassification.suggestedNextAction,
      handoff_reason: leadClassification.handoffReason,
      classification_updated_at: new Date().toISOString(),
      ...(persistTrack ? { primary_track: persistTrack } : {}),
    });

    const authorisedClaims = await loadProductClaims(supabase, config.product.code);

    const decision = await runAiDecision(
      supabase,
      {
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
          partnerInvolved:
            lead.partner_involved === null || lead.partner_involved === undefined
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
          primaryTrack: effectiveTrack,
          inquiryType: leadClassification.inquiryType,
          productInterest: effectiveProductInterest,
          intakeSegment: leadClassification.intakeSegment,
          classificationConfidence: leadClassification.confidence,
          classificationSummary: leadClassification.operatorSummary,
          suggestedNextAction: leadClassification.suggestedNextAction,
          handoffReason: leadClassification.handoffReason,
          channel,
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
      },
      correlationId,
    );

    const out = decision.output;

    if (
      leadClassification.intakeSegment === 'support_or_existing' &&
      !out.escalateToMia &&
      !out.escalateToPhoneSales
    ) {
      out.escalateToMia = true;
      out.createQueueType = 'human_handoff';
      out.sendMode = 'manual_only';
      out.notesForMia = leadClassification.handoffReason ?? leadClassification.operatorSummary;
      out.replyText = null;
      out.policyFlags = Array.from(new Set([...out.policyFlags, 'support_or_existing_lead']));
    } else if (
      leadClassification.intakeSegment === 'needs_human' &&
      !out.escalateToMia &&
      !out.escalateToPhoneSales
    ) {
      out.escalateToPhoneSales = true;
      out.createQueueType = 'phone_escalation';
      out.notesForMia = leadClassification.handoffReason ?? leadClassification.operatorSummary;
    }

    // Auto-escalate to a human phone call when the lead has been milking
    // free advice across many turns OR has logged repeat phone calls without
    // moving forward. Keep the existing AI reply (lets the bot acknowledge
    // before the human follow-up) but force a phone-sales queue item.
    const FREE_ADVICE_CEILING = 5;
    const PHONE_CALL_CEILING = 2;
    let autoEscalated = false;
    if (!out.escalateToPhoneSales && !out.escalateToMia) {
      if (freeAdviceCount >= FREE_ADVICE_CEILING || priorPhoneCallCount >= PHONE_CALL_CEILING) {
        out.escalateToPhoneSales = true;
        out.createQueueType = 'phone_escalation';
        out.notesForMia =
          out.notesForMia ??
          (freeAdviceCount >= FREE_ADVICE_CEILING
            ? `יעוץ חינמי מתמשך (${freeAdviceCount} פניות) — אסקלציה לטלפון.`
            : `${priorPhoneCallCount} שיחות טלפון קודמות ללא התקדמות.`);
        autoEscalated = true;
        log.info('orchestrate_auto_escalated', {
          fn: 'orchestrate',
          correlationId,
          leadId,
          reason: freeAdviceCount >= FREE_ADVICE_CEILING ? 'free_advice' : 'repeat_calls',
          freeAdviceCount,
          priorPhoneCallCount,
        });
      }
    }

    const desiredMode = out.sendMode;
    let effectiveMode = resolveSendMode(
      desiredMode,
      lead.last_inbound_at,
      config.whatsappSession.freeformWindowHours,
    );
    // Tier 8.A — Instagram has no template product: outside the 24h
    // window nothing can be sent. Queue the AI reply as a pending
    // manual reply (flushed by the next customer inbound) instead of
    // attempting an impossible send.
    if (channel === 'instagram' && effectiveMode === 'template') {
      effectiveMode = 'manual_only';
      if (out.replyText) {
        await supabase.from('pending_manual_replies').insert({
          lead_id: leadId,
          conversation_id: conversationId,
          text: out.replyText.slice(0, 2000),
          sender_type: 'ai',
          status: 'queued',
        });
        log.info('orchestrate_ig_reply_queued_outside_window', {
          fn: 'orchestrate', correlationId, leadId, conversationId,
        });
      }
    }

    let sendResult: { ok: boolean; providerMessageId?: string; error?: string } = { ok: false };
    let attemptedSend = false;

    if (out.replyText && (effectiveMode === 'freeform' || effectiveMode === 'template')) {
      attemptedSend = true;
      try {
        if (effectiveMode === 'freeform') {
          sendResult = channel === 'instagram'
            ? await sendInstagramText(lead.ig_user_id as string, out.replyText)
            : await sendWhatsAppText(lead.phone as string, out.replyText);
        } else {
          sendResult = await sendWhatsAppTemplate(
            lead.phone as string,
            config.whatsappSession.fallbackTemplateName,
            fallbackTemplateParams(out.replyText),
          );
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
      const updates: Record<string, unknown> = {
        lead_score: nextScore,
        inquiry_type: leadClassification.inquiryType,
        product_interest: effectiveProductInterest,
        intake_segment: leadClassification.intakeSegment,
        classification_confidence: leadClassification.confidence,
        classification_summary: leadClassification.operatorSummary,
        suggested_next_action: leadClassification.suggestedNextAction,
        handoff_reason: leadClassification.handoffReason,
        classification_updated_at: new Date().toISOString(),
        ...(persistTrack ? { primary_track: persistTrack } : {}),
      };
      // Persist lead data the bot captured (fill-only — never clobber existing).
      if (out.extractedName && !lead.full_name) updates.full_name = out.extractedName;
      if (out.estimatedEquity) updates.estimated_equity = out.estimatedEquity;
      if (out.interestSummary) updates.goal_summary = out.interestSummary;
      if (out.leadHeatUpdate) updates.lead_heat = out.leadHeatUpdate;
      if (out.nextActionType) updates.next_action_type = out.nextActionType;
      if (out.nextActionDueAt) updates.next_action_due_at = out.nextActionDueAt;
      else
        updates.next_action_due_at = new Date(
          Date.now() + config.followUpDelays.firstResponseMinutes * 60_000,
        ).toISOString();
      if (out.playbookName && lead.ai_playbook_stage !== out.playbookName) {
        updates.ai_playbook_stage = out.playbookName;
        updates.ai_playbook_stage_at = new Date().toISOString();
      }

      const replyTopics = extractTopicsFromText(out.replyText);
      const inboundTopics = extractTopicsFromText(lastLeadMessage as string | null);
      const combinedTopics = Array.from(new Set([...inboundTopics, ...replyTopics]));
      if (combinedTopics.length) {
        const priorTopics = Array.isArray(lead.topics_touched) ? (lead.topics_touched as TopicEntry[]) : [];
        updates.topics_touched = mergeTopics(priorTopics, combinedTopics);
      }

      await updateLeadFields(supabase, leadId, updates);

      if (out.leadStatusUpdate) {
        await transitionLeadStatus(
          supabase,
          leadId,
          out.leadStatusUpdate,
          'ai',
          `playbook:${out.playbookName}`,
        );
      }

      await logLeadEvent(
        supabase,
        leadId,
        'ai_reply_sent',
        'ai',
        {
          playbook: out.playbookName,
          score_delta: out.scoreDelta,
          heat_update: out.leadHeatUpdate,
          send_mode: effectiveMode,
          auto_escalated: autoEscalated,
          correlation_id: correlationId,
        },
        conversationId,
      );
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
      // Template misconfigured in Meta (#132000/#132001) — the reply text
      // is fine, only the wrapper is broken. Park it in
      // pending_manual_replies so the customer's next inbound flushes it
      // (same mechanism as the IG outside-window path) instead of losing
      // the reply until someone reads the DLQ.
      if (effectiveMode === 'template' && out.replyText && isTemplateConfigError(sendResult.error)) {
        await supabase.from('pending_manual_replies').insert({
          lead_id: leadId,
          conversation_id: conversationId,
          text: out.replyText.slice(0, 2000),
          sender_type: 'ai',
          status: 'queued',
          metadata: { source: 'template_config_error', correlationId },
        });
        log.warn('orchestrate_template_config_error_reply_queued', {
          fn: 'orchestrate', correlationId, leadId, conversationId,
        });
      }
      await ensurePendingQueueItem(supabase, {
        leadId,
        queueType: 'failed_automation',
        priorityLevel: 1,
        reason: isTemplateConfigError(sendResult.error)
          ? 'תבנית הוואטסאפ המאושרת לא תואמת (מספר משתנים) — יש לתקן ב-Meta; התשובה נשמרה ותישלח כשהלקוח יכתוב'
          : 'WhatsApp outbound failed after retries',
        queueSummary: sendResult.error ?? 'unknown_error',
        payloadJson: { effectiveMode, correlationId },
      });
    } else if (isModelExecutionFailure(decision.executionStatus) || decision.executionStatus === 'validation_blocked') {
      // Model/provider unavailable → make the failure visible immediately.
      // The dispatcher itself completed successfully, but no customer reply
      // was produced; without this guard the only signal is a delayed ai_stuck
      // SLA item, which is too opaque for operators.
      await supabase.from('integration_logs').insert({
        source: 'ai_decision',
        status: 'error',
        lead_id: leadId,
        request_data: { execution_status: decision.executionStatus, playbook: out.playbookName },
        response_data: { raw_output: decision.rawOutput ?? null, validated_output: out },
        error_message: decision.executionStatus,
      });
      await ensurePendingQueueItem(supabase, {
        leadId,
        queueType: 'failed_automation',
        priorityLevel: 1,
        reason: `AI decision failed: ${decision.executionStatus}`,
        queueSummary: 'ה־AI לא ייצר תשובה — נדרש טיפול ידני או תיקון הגדרת מודל.',
        payloadJson: { executionStatus: decision.executionStatus, correlationId },
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
          classification: leadClassification,
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
      fn: 'orchestrate',
      correlationId,
      leadId,
      conversationId,
      sentOk: sendResult.ok,
      mode: effectiveMode,
      status: decision.executionStatus,
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

function isModelExecutionFailure(status: string): boolean {
  return (
    status === 'model_disabled' ||
    status === 'circuit_open' ||
    status.endsWith('_timeout') ||
    status.endsWith('_empty_content') ||
    status.endsWith('_exception') ||
    /^(openai|gemini)_error:/.test(status)
  );
}
