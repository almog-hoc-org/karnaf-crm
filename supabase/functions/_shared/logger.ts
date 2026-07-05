// Lightweight structured logger. Emits one JSON line per call so logs flow
// straight into Supabase log explorer / external aggregators without parsing.
//
// Optional Sentry-style fan-out: if SENTRY_DSN is set in the function's
// environment, every `log.error` (and warn) is also POSTed there in the
// background. Failures are swallowed so the host function never inherits
// observability problems. Without the env var the helper is a no-op.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  fn?: string;
  correlationId?: string;
  leadId?: string;
  conversationId?: string;
  providerMessageId?: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, message: string, fields?: LogFields) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  };
  console.log(JSON.stringify(line));
  if (level === 'error' || level === 'warn') {
    forwardToSentry(line).catch(() => { /* never break the caller */ });
  }
}

const SENTRY_DSN = (typeof Deno !== 'undefined') ? (Deno.env.get('SENTRY_DSN') ?? '') : '';
const SENTRY_RELEASE = (typeof Deno !== 'undefined') ? (Deno.env.get('SENTRY_RELEASE') ?? '') : '';
const SENTRY_ENV = (typeof Deno !== 'undefined') ? (Deno.env.get('SENTRY_ENVIRONMENT') ?? 'production') : 'production';

async function forwardToSentry(line: Record<string, unknown>): Promise<void> {
  if (!SENTRY_DSN) return;
  try {
    await fetch(SENTRY_DSN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...line, release: SENTRY_RELEASE, environment: SENTRY_ENV, source: 'edge-function' }),
      keepalive: true,
    });
  } catch { /* swallow */ }
}

export const log = {
  debug: (msg: string, f?: LogFields) => emit('debug', msg, f),
  info: (msg: string, f?: LogFields) => emit('info', msg, f),
  warn: (msg: string, f?: LogFields) => emit('warn', msg, f),
  error: (msg: string, f?: LogFields) => emit('error', msg, f),
};

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

export function correlationFromRequest(req: Request): string {
  return req.headers.get('x-correlation-id') || newCorrelationId();
}
