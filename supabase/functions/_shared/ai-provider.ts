// AI provider abstraction. Picks an implementation at request time so we can
// swap models (OpenAI ↔ Gemini) without touching the orchestrator. Each
// provider returns a JSON string conforming to the AiDecisionOutput shape;
// the caller is still responsible for parsing, validation, and circuit-breaker
// bookkeeping.
//
// Selection order (in `getAiProvider`):
//   1. AI_PROVIDER env var, if set to 'openai' or 'gemini' → use that.
//   2. Otherwise pick whichever provider has its API key configured.
//      OpenAI wins ties (legacy default).
//   3. If nothing is configured, returns the OpenAI provider; runAiDecision
//      will short-circuit with `model_disabled` via `isConfigured()`.

import { env } from './env.ts';

export type AiProviderName = 'openai' | 'gemini' | 'groq';

export interface AiGenerateRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
}

export interface AiGenerateResponse {
  /** Raw JSON-shaped string the model produced. Caller parses. */
  content: string;
  /** Model identifier suitable for ai_decisions.model_name. */
  model: string;
}

export class AiProviderError extends Error {
  constructor(
    /** Short status used as ai_decisions.execution_status (e.g. `openai_error:401`). */
    public readonly status: string,
    /** Truncated raw response/exception, ≤400 chars. */
    public readonly detail: string,
  ) {
    super(`${status}: ${detail}`);
  }
}

export interface AiProvider {
  readonly name: AiProviderName;
  /** Configured model name (env-driven). Used for logging even before a call. */
  modelName(): string;
  /** True only if the API key for this provider is set. */
  isConfigured(): boolean;
  /** Throws AiProviderError on any HTTP/parse/empty-content failure. */
  generateJson(req: AiGenerateRequest): Promise<AiGenerateResponse>;
}

/**
 * Hard timeout for any model API round-trip. Without this, a hung upstream
 * blocks the conversation-lock-holding orchestrate-message invocation
 * indefinitely, exhausting the Deno connection pool and stalling SLA
 * for every other lead.
 */
const AI_FETCH_TIMEOUT_MS = 20_000;

/** fetch() wrapper that aborts after AI_FETCH_TIMEOUT_MS and converts the
 *  AbortError into an AiProviderError tagged `<provider>_timeout`. The caller
 *  re-uses `recordFailure` on its circuit breaker so repeated timeouts open
 *  the breaker and stop further calls to that provider for the cooldown. */
async function fetchWithTimeout(
  providerName: AiProviderName,
  input: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new AiProviderError(
        `${providerName}_timeout`,
        `timeout_after_${AI_FETCH_TIMEOUT_MS}ms`,
      );
    }
    throw new AiProviderError(
      `${providerName}_fetch_failed`,
      String((err as Error)?.message ?? err).slice(0, 400),
    );
  } finally {
    clearTimeout(timer);
  }
}

class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;
  modelName() { return env.openaiModel(); }
  isConfigured() { return !!env.openaiApiKey(); }

  async generateJson({ systemPrompt, userPrompt, temperature = 0.4 }: AiGenerateRequest) {
    const model = this.modelName();
    const r = await fetchWithTimeout(this.name, 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.openaiApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        temperature,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      throw new AiProviderError(`openai_error:${r.status}`, errText.slice(0, 400));
    }
    const json = await r.json();
    const content = json.choices?.[0]?.message?.content as string | undefined;
    if (!content) {
      throw new AiProviderError('openai_empty_content', JSON.stringify(json).slice(0, 400));
    }
    return { content, model };
  }
}

class GeminiProvider implements AiProvider {
  readonly name = 'gemini' as const;
  modelName() { return env.geminiModel(); }
  isConfigured() { return !!env.geminiApiKey(); }

  async generateJson({ systemPrompt, userPrompt, temperature = 0.4 }: AiGenerateRequest) {
    const model = this.modelName();
    // Key in x-goog-api-key header rather than ?key= so it never appears in
    // proxy/CDN/Sentry logs that capture URLs.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const r = await fetchWithTimeout(this.name, url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.geminiApiKey(),
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature,
          // Gemini 1.5+ honours this and constrains output to valid JSON.
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      throw new AiProviderError(`gemini_error:${r.status}`, errText.slice(0, 400));
    }
    const json = await r.json();

    // Gemini surfaces safety blocks separately from HTTP errors.
    const blockReason = json.promptFeedback?.blockReason ?? json.candidates?.[0]?.finishReason;
    if (blockReason && blockReason !== 'STOP' && blockReason !== 'MAX_TOKENS') {
      throw new AiProviderError(
        `gemini_blocked:${blockReason}`,
        JSON.stringify({ promptFeedback: json.promptFeedback, finishReason: json.candidates?.[0]?.finishReason }).slice(0, 400),
      );
    }

    const content = json.candidates?.[0]?.content?.parts?.[0]?.text as string | undefined;
    if (!content) {
      throw new AiProviderError('gemini_empty_content', JSON.stringify(json).slice(0, 400));
    }
    return { content, model };
  }
}

// Groq's chat-completions endpoint is OpenAI-compatible — same body shape,
// same response shape, including response_format={type:'json_object'}.
class GroqProvider implements AiProvider {
  readonly name = 'groq' as const;
  modelName() { return env.groqModel(); }
  isConfigured() { return !!env.groqApiKey(); }

  async generateJson({ systemPrompt, userPrompt, temperature = 0.4 }: AiGenerateRequest) {
    const model = this.modelName();
    const r = await fetchWithTimeout(this.name, 'https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.groqApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        temperature,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      throw new AiProviderError(`groq_error:${r.status}`, errText.slice(0, 400));
    }
    const json = await r.json();
    const content = json.choices?.[0]?.message?.content as string | undefined;
    if (!content) {
      throw new AiProviderError('groq_empty_content', JSON.stringify(json).slice(0, 400));
    }
    return { content, model };
  }
}

const PROVIDERS: Record<AiProviderName, AiProvider> = {
  openai: new OpenAiProvider(),
  gemini: new GeminiProvider(),
  groq: new GroqProvider(),
};

export function getAiProvider(): AiProvider {
  const explicit = env.aiProvider();
  if (explicit === 'openai' || explicit === 'gemini' || explicit === 'groq') return PROVIDERS[explicit];
  if (PROVIDERS.openai.isConfigured()) return PROVIDERS.openai;
  if (PROVIDERS.gemini.isConfigured()) return PROVIDERS.gemini;
  if (PROVIDERS.groq.isConfigured()) return PROVIDERS.groq;
  return PROVIDERS.openai;
}
