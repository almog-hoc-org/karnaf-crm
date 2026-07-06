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

type AiProvider = 'openai' | 'gemini';

interface ModelCallResult {
  ok: boolean;
  content?: string;
  raw?: unknown;
  status?: number;
  errorText?: string;
}

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

  // Whether the bot already greeted/replied in this conversation. Used to
  // break the "stuck in first_contact" loop when lead_status hasn't advanced
  // yet (e.g. the status transition from a prior turn hasn't committed).
  const hasPriorBotMessage = context.recentMessages.some(
    (m) => m.senderType === 'ai' || m.senderType === 'system',
  );

  const playbook = selectPlaybook({
    inboundText: lastInbound,
    leadStatus: context.lead.status,
    source: context.lead.source,
    paymentStatus: context.lead.paymentStatus,
    hoursSinceLastInbound: hoursSinceInbound,
    freeAdviceCount: context.freeAdviceCount,
    inferredIntent: context.intentContext?.intent,
    intentConfidence: context.intentContext?.confidence,
    hasPriorBotMessage,
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

  const provider = resolveAiProvider();
  const modelName = resolveModelName(provider);
  const apiKey = resolveApiKey(provider);

  if (!apiKey) {
    return blockWith('model_disabled', null);
  }

  const breakerCfg = { threshold: 3, cooldownMs: 5 * 60 * 1000 };
  if (isOpen(provider, breakerCfg)) {
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
    const systemPrompt = buildAiSystemPrompt(playbook, context, overrides);
    const userPrompt = buildAiUserPrompt(context);
    const response = await callModel({ provider, modelName, apiKey, systemPrompt, userPrompt, signal: controller.signal });

    if (!response.ok) {
      recordFailure(provider, breakerCfg);
      return blockWith(`${provider}_error:${response.status ?? 'unknown'}`, (response.errorText ?? '').slice(0, 400));
    }

    const content = response.content;
    if (!content) {
      recordFailure(provider, breakerCfg);
      return blockWith(`${provider}_empty_content`, response.raw ?? null);
    }

    let parsed: Partial<AiDecisionOutput>;
    try {
      parsed = JSON.parse(content) as Partial<AiDecisionOutput>;
    } catch {
      recordFailure(provider, breakerCfg);
      return blockWith(`${provider}_exception`, content.slice(0, 400));
    }

    const merged: AiDecisionOutput = {
      ...emptyOutput(playbook.name),
      ...parsed,
      sendMode: parsed.sendMode ?? 'freeform',
      policyFlags: Array.isArray(parsed.policyFlags) ? parsed.policyFlags : [],
      playbookName: playbook.name,
    };

    const validated = validateAiDecision({ output: merged, ...validateInput });
    recordSuccess(provider);
    // Benign normalisations (e.g. coercing a handoff-like queue type to the
    // canonical value) should not be reported as a blocked decision — that
    // mislabels a successful turn as a failure in the operator dashboards.
    const blockingFlags = validated.flags.filter((f) => f !== 'queue_normalized');
    const status = blockingFlags.length ? 'validation_blocked' : `${provider}_success`;
    await logDecision(supabase, context, validated.output, status, parsed, correlationId, promptVersion);
    return { output: validated.output, executionStatus: status, rawOutput: parsed, promptVersion };
  } catch (err) {
    recordFailure(provider, breakerCfg);
    if ((err as Error)?.name === 'AbortError') {
      return blockWith(`${provider}_timeout`, 'timeout_after_20000ms');
    }
    return blockWith(`${provider}_exception`, String(err));
  } finally {
    clearTimeout(timer);
  }
}

function resolveAiProvider(): AiProvider {
  const provider = env.aiProvider();
  return provider === 'gemini' || provider === 'google' ? 'gemini' : 'openai';
}

function resolveModelName(provider: AiProvider): string {
  return provider === 'gemini' ? env.geminiModel() : env.openaiModel();
}

function resolveApiKey(provider: AiProvider): string {
  return provider === 'gemini' ? env.geminiApiKey() : env.openaiApiKey();
}

async function callModel(args: {
  provider: AiProvider;
  modelName: string;
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  signal: AbortSignal;
}): Promise<ModelCallResult> {
  return args.provider === 'gemini' ? callGemini(args) : callOpenAi(args);
}

async function callOpenAi(args: {
  modelName: string;
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  signal: AbortSignal;
}): Promise<ModelCallResult> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: args.modelName,
      response_format: { type: 'json_object' },
      temperature: 0.4,
      messages: [
        { role: 'system', content: args.systemPrompt },
        { role: 'user', content: args.userPrompt },
      ],
    }),
    signal: args.signal,
  });

  if (!response.ok) {
    return { ok: false, status: response.status, errorText: await response.text().catch(() => '') };
  }

  const raw = await response.json();
  return { ok: true, raw, content: raw.choices?.[0]?.message?.content as string | undefined };
}

async function callGemini(args: {
  modelName: string;
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  signal: AbortSignal;
}): Promise<ModelCallResult> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(args.modelName)}:generateContent?key=${encodeURIComponent(args.apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: args.systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: args.userPrompt }] }],
        generationConfig: {
          temperature: 0.4,
          responseMimeType: 'application/json',
        },
      }),
      signal: args.signal,
    },
  );

  if (!response.ok) {
    return { ok: false, status: response.status, errorText: await response.text().catch(() => '') };
  }

  const raw = await response.json();
  const content = raw.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text ?? '')
    .join('')
    .trim();
  return { ok: true, raw, content };
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
  const provider = resolveAiProvider();
  const apiKey = resolveApiKey(provider);
  try {
    await supabase.from('ai_decisions').insert({
      lead_id: context.lead.id,
      model_name: apiKey ? resolveModelName(provider) : 'disabled',
      prompt_version: promptVersion,
      playbook_name: output.playbookName,
      input_context_json: { ...context, correlationId },
      raw_output_json: rawOutput ?? {},
      validated_output_json: output,
      execution_status: executionStatus,
      error_message:
        (executionStatus.startsWith('openai_') || executionStatus.startsWith('gemini_')) &&
        !executionStatus.endsWith('_success')
          ? executionStatus
          : null,
    });
  } catch (err) {
    log.error('ai_decisions_insert_failed', { fn: 'logDecision', correlationId, err: String(err) });
  }
}
