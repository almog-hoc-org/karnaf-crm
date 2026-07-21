// Safety-net generic acknowledgment — pure decision logic. Mirrored in
// this file IS the tested mirror of _shared/generic-ack.ts; keep in sync.
//
// When the AI pipeline cannot produce a customer reply (model disabled,
// circuit open, provider error, validation blocked), the lead used to get
// SILENCE. This decides whether to send the configurable "we got your
// message, a rep will get back to you" ack instead — at most once per
// window, and only when the feature is enabled.

export interface SafetyNetConfig {
  enabled: boolean;
  ackText: string;
  oncePerHours: number;
  mode: 'generic' | 'placeholder_brain';
}

export const DEFAULT_SAFETY_NET: SafetyNetConfig = {
  enabled: true,
  ackText: 'קיבלנו את הפנייה, נציג מצוות קרנף יחזור אליך בהקדם 🦏',
  oncePerHours: 24,
  mode: 'generic',
};

export function resolveSafetyNet(raw: unknown): SafetyNetConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : DEFAULT_SAFETY_NET.enabled,
    ackText:
      typeof cfg.ackText === 'string' && cfg.ackText.trim()
        ? cfg.ackText.trim()
        : DEFAULT_SAFETY_NET.ackText,
    oncePerHours:
      typeof cfg.oncePerHours === 'number' && cfg.oncePerHours >= 1 && cfg.oncePerHours <= 168
        ? cfg.oncePerHours
        : DEFAULT_SAFETY_NET.oncePerHours,
    mode: cfg.mode === 'placeholder_brain' ? 'placeholder_brain' : 'generic',
  };
}

/**
 * Execution statuses that mean "the AI produced nothing for the customer".
 * Mirrors orchestrate-message's isModelExecutionFailure taxonomy — note
 * provider errors carry a detail suffix (e.g. 'openai_error:429').
 */
export function isAckWorthyFailure(executionStatus: string): boolean {
  if (executionStatus === 'validation_blocked') return true;
  return (
    executionStatus === 'model_disabled' ||
    executionStatus === 'circuit_open' ||
    executionStatus.endsWith('_timeout') ||
    executionStatus.endsWith('_empty_content') ||
    executionStatus.endsWith('_exception') ||
    executionStatus.endsWith('_error') ||
    /^(openai|gemini)_error:/.test(executionStatus)
  );
}

export function shouldSendGenericAck(input: {
  config: SafetyNetConfig;
  executionStatus: string;
  lastAckAt: string | null;
  now?: Date;
}): boolean {
  const { config, executionStatus, lastAckAt } = input;
  if (!config.enabled) return false;
  if (!isAckWorthyFailure(executionStatus)) return false;
  if (!lastAckAt) return true;
  const now = input.now ?? new Date();
  const last = new Date(lastAckAt).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= config.oncePerHours * 60 * 60 * 1000;
}
