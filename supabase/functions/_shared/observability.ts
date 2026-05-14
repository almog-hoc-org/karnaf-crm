// Edge Function observability shim. Mirrors a subset of @sentry/deno so a
// future drop-in upgrade is a one-file swap. Without SENTRY_DSN this whole
// module is a silent no-op; nothing ships to the network, no fetches.
//
// Surface (subset of @sentry/deno):
//   - captureException(err, context?)
//   - captureMessage(level, msg, context?)
//   - withFunctionScope({fn, correlationId, leadId?}, work)
//
// On upgrade (after deno-importing https://deno.land/x/sentry@... or the
// official @sentry/deno once Edge Runtime supports it — see runbook), the
// `send()` body is replaced with `Sentry.captureXxx`. Call sites stay the same.

import { optional } from './env.ts';
import { log } from './logger.ts';

type Level = 'error' | 'warning' | 'info';

interface SentryEvent {
  level: Level;
  message: string;
  release?: string;
  environment?: string;
  tags?: Record<string, string>;
  contexts?: Record<string, Record<string, unknown>>;
  exception?: { values: Array<{ type: string; value: string; stacktrace?: string }> };
  timestamp: string;
  fingerprint?: string[];
}

const dsn = optional('SENTRY_DSN');
const environment = optional('SENTRY_ENVIRONMENT', 'production');
const release = optional('SENTRY_RELEASE');

export const observabilityEnabled = dsn.length > 0;

function fingerprintFor(message: string, stack?: string): string[] {
  if (!stack) return [message];
  const firstFrame = stack.split('\n').find((l) => l.trim().startsWith('at ')) ?? '';
  return [message, firstFrame.trim().slice(0, 200)];
}

async function send(event: SentryEvent): Promise<void> {
  if (!observabilityEnabled) return;
  try {
    const r = await fetch(dsn, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!r.ok) {
      // Don't recurse into observability on its own failure.
      log.warn('sentry_ingest_failed', { fn: 'observability', status: r.status });
    }
  } catch {
    // Reporter must never throw into the caller.
  }
}

function buildEvent(level: Level, message: string, opts: {
  stack?: string;
  exceptionType?: string;
  tags?: Record<string, string>;
  context?: Record<string, unknown>;
} = {}): SentryEvent {
  const event: SentryEvent = {
    level,
    message,
    release: release || undefined,
    environment,
    tags: opts.tags && Object.keys(opts.tags).length > 0 ? opts.tags : undefined,
    contexts: opts.context && Object.keys(opts.context).length > 0
      ? { extra: opts.context }
      : undefined,
    timestamp: new Date().toISOString(),
    fingerprint: fingerprintFor(message, opts.stack),
  };
  if (opts.exceptionType) {
    event.exception = {
      values: [{ type: opts.exceptionType, value: message, stacktrace: opts.stack }],
    };
  }
  return event;
}

export function captureException(
  error: unknown,
  tags: Record<string, string> = {},
  context: Record<string, unknown> = {},
): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const exceptionType = error instanceof Error ? error.name : 'Error';
  void send(buildEvent('error', message, { stack, exceptionType, tags, context }));
}

export function captureMessage(
  level: Level,
  message: string,
  tags: Record<string, string> = {},
  context: Record<string, unknown> = {},
): void {
  void send(buildEvent(level, message, { tags, context }));
}

/** Wrap an Edge Function handler body so any unhandled throw is reported
 *  to Sentry tagged with fn/correlation/lead before being re-thrown. The
 *  re-throw preserves the existing logger.error path. */
export async function withFunctionScope<T>(
  scope: { fn: string; correlationId: string; leadId?: string },
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (err) {
    captureException(err, {
      fn: scope.fn,
      correlation_id: scope.correlationId,
      ...(scope.leadId ? { lead_id: scope.leadId } : {}),
    });
    throw err;
  }
}
