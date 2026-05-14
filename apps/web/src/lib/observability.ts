// Frontend observability shim. Mirrors the @sentry/react surface so a future
// drop-in upgrade is a one-file swap. Without VITE_SENTRY_DSN this entire
// module is a silent no-op; nothing ships to the network, nothing throws
// into the host app.
//
// Surface (subset of @sentry/react):
//   - captureException(err, context?)         // unhandled errors
//   - captureMessage(level, msg, context?)    // explicit warnings / info
//   - addBreadcrumb(category, message, data?) // navigation + interactions
//   - withScope(fn)                            // run with extra tags
//   - installGlobalReporters()                 // wire window error events
//
// On upgrade (after `npm install @sentry/react @sentry/tracing
// sentry-vite-plugin` — see docs/runbooks/production-hardening-user-actions.md):
//   replace the implementations below with `import * as Sentry from
//   '@sentry/react'` and `Sentry.init({...})` in main.tsx. Call sites stay
//   the same.

type Level = 'error' | 'warning' | 'info';

interface Breadcrumb {
  category: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
  level: Level;
}

interface SentryEvent {
  level: Level;
  message: string;
  release?: string;
  environment?: string;
  tags?: Record<string, string>;
  contexts?: Record<string, Record<string, unknown>>;
  exception?: { values: Array<{ type: string; value: string; stacktrace?: string }> };
  breadcrumbs?: Breadcrumb[];
  timestamp: string;
  /** Stable fingerprint hash so Sentry groups identical events together. */
  fingerprint?: string[];
}

const dsn = import.meta.env.VITE_SENTRY_DSN;
const release = import.meta.env.VITE_RELEASE;
const environment = import.meta.env.VITE_ENV ?? 'production';

export const observabilityEnabled = typeof dsn === 'string' && dsn.length > 0;

// Last-N breadcrumb buffer. Capped so a long-running tab never grows
// unbounded; new events flush the buffer along with the payload.
const MAX_BREADCRUMBS = 50;
const breadcrumbs: Breadcrumb[] = [];

// Stack of per-scope tag/context overrides. `withScope` pushes a frame
// and pops it after the callback completes.
interface ScopeFrame { tags?: Record<string, string>; context?: Record<string, unknown>; }
const scopeStack: ScopeFrame[] = [];

function currentScope(): ScopeFrame {
  if (scopeStack.length === 0) return {};
  const merged: ScopeFrame = { tags: {}, context: {} };
  for (const frame of scopeStack) {
    Object.assign(merged.tags!, frame.tags ?? {});
    Object.assign(merged.context!, frame.context ?? {});
  }
  return merged;
}

function fingerprintFor(message: string, stack?: string): string[] {
  // Stable across repeated errors of the same kind so Sentry's UI groups
  // them. Falls back to the message alone when no stack is available.
  if (!stack) return [message];
  const firstFrame = stack.split('\n').find((l) => l.trim().startsWith('at ')) ?? '';
  return [message, firstFrame.trim().slice(0, 200)];
}

function send(event: SentryEvent) {
  if (!observabilityEnabled || !dsn) return;
  // Use sendBeacon when available so the request survives page unload.
  try {
    const body = JSON.stringify(event);
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(dsn, blob);
      return;
    }
    void fetch(dsn, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
  } catch {
    // Reporter must never throw into the host app.
  }
}

function buildEvent(level: Level, message: string, opts: {
  stack?: string;
  exceptionType?: string;
  context?: Record<string, unknown>;
} = {}): SentryEvent {
  const scope = currentScope();
  const event: SentryEvent = {
    level,
    message,
    release,
    environment,
    tags: scope.tags && Object.keys(scope.tags).length > 0 ? scope.tags : undefined,
    contexts: opts.context || (scope.context && Object.keys(scope.context).length > 0)
      ? { extra: { ...(scope.context ?? {}), ...(opts.context ?? {}) } }
      : undefined,
    breadcrumbs: breadcrumbs.length > 0 ? [...breadcrumbs] : undefined,
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

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const exceptionType = error instanceof Error ? error.name : 'Error';
  send(buildEvent('error', message, { stack, exceptionType, context }));
}

export function captureMessage(
  level: Level,
  message: string,
  context?: Record<string, unknown>,
): void {
  send(buildEvent(level, message, { context }));
}

export function addBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, unknown>,
  level: Level = 'info',
): void {
  breadcrumbs.push({
    category,
    message,
    data,
    timestamp: new Date().toISOString(),
    level,
  });
  if (breadcrumbs.length > MAX_BREADCRUMBS) {
    breadcrumbs.splice(0, breadcrumbs.length - MAX_BREADCRUMBS);
  }
}

export function withScope<T>(
  fn: (scope: { setTag: (k: string, v: string) => void; setContext: (k: string, v: unknown) => void }) => T,
  tags: Record<string, string> = {},
  context: Record<string, unknown> = {},
): T {
  const frame: ScopeFrame = { tags: { ...tags }, context: { ...context } };
  scopeStack.push(frame);
  try {
    return fn({
      setTag: (k, v) => { frame.tags = { ...(frame.tags ?? {}), [k]: v }; },
      setContext: (k, v) => { frame.context = { ...(frame.context ?? {}), [k]: v }; },
    });
  } finally {
    scopeStack.pop();
  }
}

export function installGlobalReporters(): void {
  if (!observabilityEnabled) return;
  window.addEventListener('error', (event) => {
    captureException(event.error ?? event.message, {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    captureException(event.reason, { kind: 'unhandledrejection' });
  });
  // Track route changes as breadcrumbs so an error always shows the user's
  // recent navigation. Routers fire popstate; SPAs that use pushState are
  // covered by patching history.pushState below.
  const recordNav = () => addBreadcrumb('navigation', location.pathname + location.search);
  window.addEventListener('popstate', recordNav);
  const origPushState = history.pushState.bind(history);
  history.pushState = function patchedPushState(...args: Parameters<typeof history.pushState>) {
    const result = origPushState(...args);
    recordNav();
    return result;
  };
}

// Legacy aliases — keep the original names exported so existing call sites
// (LoginPage, ErrorBoundary, etc.) compile during the gradual migration.
export const reportError = (error: unknown, context?: Record<string, unknown>) =>
  captureException(error, context);
export const reportWarning = (message: string, context?: Record<string, unknown>) =>
  captureMessage('warning', message, context);
