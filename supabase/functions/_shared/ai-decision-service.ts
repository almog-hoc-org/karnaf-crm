import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { AiDecisionContext, AiDecisionOutput } from './ai-contract.ts';
import { buildAiSystemPrompt, buildAiUserPrompt } from './ai-prompt.ts';
import { selectPlaybook } from './playbooks.ts';
import { validateAiDecision } from './ai-validation.ts';
import { isOpen, recordFailure, recordSuccess } from './circuit-breaker.ts';
import { pickPromptVariant, type PromptVariant } from './prompt-variant.ts';
import { resolveMaxReplyChars } from './reply-length.ts';
import { env } from './env.ts';
import { log } from './logger.ts';

const BREAKER_KEY = 'openai';

export interface DecisionResult {
  output: AiDecisionOutput;
  executionStatus: string;
  rawOutput: unknown;
  promptVersion: string;
}

export async function runAiDecision(
  supabase: SupabaseClient,
  context: AiDecisionContext,
  correlationId: string,
): Promise<DecisionResult> {
  const lastInbound = context.recentMessages.filter((m) => m.senderType === 'lead').slice(-1)[0]?.contentText ?? '';
  const hoursSinceInbound = context.lead.lastInboundAt
    ? (Date.now() - Date.parse(context.lead.lastInboundAt)) / (1000 * 60 * 60)
    : null;

  const playbook = selectPlaybook({
    inboundText: lastInbound,
    leadStatus: context.lead.status,
    source: context.lead.source,
    paymentStatus: context.lead.paymentStatus,
    hoursSinceLastInbound: hoursSinceInbound,
    freeAdviceCount: context.freeAdviceCount,
    inferredIntent: context.intentContext?.intent,
    intentConfidence: context.intentContext?.confidence,
  });

  // A/B variant: weighted random pick from active rows for this playbook.
  // Falls back to the static prompt_version configured in crm_config.
  let variant: PromptVariant | null = null;
  try {
    variant = await pickPromptVariant(supabase, playbook.name, {
      heat: context.lead.heat,
      source: context.lead.source,
      status: context.lead.status,
    });
  } catch (err) {
    log.warn('variant_lookup_failed', { fn: 'runAiDecision', correlationId, err: String(err) });
  }
  const promptVersion = variant?.version ?? context.runtimeConfig.ai.promptVersion;
  const overrides = variant?.prompt_overrides ?? {};

  const maxReplyChars = resolveMaxReplyChars(context.lead.heat, context.runtimeConfig.ai.maxReplyChars);

  const validateInput = {
    currentStatus: context.lead.status,
    forbiddenClaims: context.runtimeConfig.forbiddenClaims,
    playbook,
    maxReplyChars,
    isDoNotContact: context.lead.doNotContact,
    isRemovedByRequest: context.lead.removedByRequest,
    recentAiQuestions: context.recentAiQuestions ?? [],
  } as const;

  const blockWith = (status: string, raw: unknown) => {
    const validated = validateAiDecision({ output: emptyOutput(playbook.name), ...validateInput });
    return logDecision(supabase, context, validated.output, status, raw, correlationId, promptVersion)
      .then(() => ({ output: validated.output, executionStatus: status, rawOutput: raw, promptVersion }));
  };

  if (!env.openaiApiKey()) {
    return blockWith('model_disabled', null);
  }

  const breakerCfg = { threshold: 3, cooldownMs: 5 * 60 * 1000 };
  if (isOpen(BREAKER_KEY, breakerCfg)) {
    log.warn('ai_circuit_open', { fn: 'runAiDecision', correlationId, leadId: context.lead.id });
    return blockWith('circuit_open', null);
  }

  // 20s hard timeout — without it a hung OpenAI call would block the
  // conversation lock holding orchestrate-message invocation indefinitely,
  // exhausting the Deno connection pool. Aborts surface as `openai_timeout`
  // so the circuit breaker opens after `threshold` consecutive timeouts.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.openaiApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.openaiModel(),
        response_format: { type: 'json_object' },
        temperature: 0.4,
        messages: [
          { role: 'system', content: buildAiSystemPrompt(playbook, context, overrides) },
          { role: 'user', content: buildAiUserPrompt(context) },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      recordFailure(BREAKER_KEY, breakerCfg);
      return blockWith(`openai_error:${response.status}`, errText.slice(0, 400));
    }

    const json = await response.json();
    const content = json.choices?.[0]?.message?.content as string | undefined;
    if (!content) {
      recordFailure(BREAKER_KEY, breakerCfg);
      return blockWith('openai_empty_content', json);
    }

    let parsed: Partial<AiDecisionOutput>;
    try {
      parsed = JSON.parse(content) as Partial<AiDecisionOutput>;
    } catch {
      recordFailure(BREAKER_KEY, breakerCfg);
      return blockWith('openai_exception', content.slice(0, 400));
    }

    const merged: AiDecisionOutput = {
      ...emptyOutput(playbook.name),
      ...parsed,
      sendMode: parsed.sendMode ?? 'freeform',
      policyFlags: Array.isArray(parsed.policyFlags) ? parsed.policyFlags : [],
      playbookName: playbook.name,
    };

    const validated = validateAiDecision({ output: merged, ...validateInput });
    recordSuccess(BREAKER_KEY);
    const status = validated.flags.length ? 'validation_blocked' : 'openai_success';
    await logDecision(supabase, context, validated.output, status, parsed, correlationId, promptVersion);
    return { output: validated.output, executionStatus: status, rawOutput: parsed, promptVersion };
  } catch (err) {
    recordFailure(BREAKER_KEY, breakerCfg);
    if ((err as Error)?.name === 'AbortError') {
      return blockWith('openai_timeout', 'timeout_after_20000ms');
    }
    return blockWith('openai_exception', String(err));
  } finally {
    clearTimeout(timer);
  }
}

function emptyOutput(playbookName: string): AiDecisionOutput {
  return {
    replyText: null,
    intentClassification: 'unclassified',
    leadStatusUpdate: null,
    leadHeatUpdate: null,
    scoreDelta: 0,
    escalateToMia: false,
    escalateToPhoneSales: false,
    createQueueType: null,
    nextActionType: null,
    nextActionDueAt: null,
    notesForMia: null,
    sendMode: 'no_send',
    policyFlags: [],
    playbookName,
  };
}

async function logDecision(
  supabase: SupabaseClient,
  context: AiDecisionContext,
  output: AiDecisionOutput,
  executionStatus: string,
  rawOutput: unknown,
  correlationId: string,
  promptVersion: string,
) {
  try {
    await supabase.from('ai_decisions').insert({
      lead_id: context.lead.id,
      model_name: env.openaiApiKey() ? env.openaiModel() : 'disabled',
      prompt_version: promptVersion,
      playbook_name: output.playbookName,
      input_context_json: { ...context, correlationId },
      raw_output_json: rawOutput ?? {},
      validated_output_json: output,
      execution_status: executionStatus,
      error_message: executionStatus.startsWith('openai_') && executionStatus !== 'openai_success' ? executionStatus : null,
    });
  } catch (err) {
    log.error('ai_decisions_insert_failed', { fn: 'logDecision', correlationId, err: String(err) });
  }
}
