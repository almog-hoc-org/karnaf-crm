// Sentry-backed observability for the operator console.
//
// When VITE_SENTRY_DSN is unset (local dev), every helper is a no-op so the
// browser doesn't pay any runtime cost and the build still works without
// Sentry credentials. When the DSN is present, Sentry is initialised with
// a sane default tracing + browser-replay sample rate; the project owner
// can tune the rates server-side via Sentry's UI rather than rebuilding.

import * as Sentry from '@sentry/react';

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const release = import.meta.env.VITE_RELEASE as string | undefined;
const environment = (import.meta.env.VITE_ENV as string | undefined) ?? 'production';

export const observabilityEnabled = typeof dsn === 'string' && dsn.length > 0;

let initialised = false;

function ensureInit() {
  if (initialised || !observabilityEnabled) return;
  initialised = true;
  try {
    Sentry.init({
      dsn,
      release,
      environment,
      tracesSampleRate: 0.1,
      replaysSessionSampleRate: 0.0,
      replaysOnErrorSampleRate: 1.0,
      integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
    });
  } catch {
    // never throw into the host app
  }
}

export function reportError(error: unknown, context?: Record<string, unknown>) {
  ensureInit();
  if (!observabilityEnabled) return;
  try {
    Sentry.captureException(error, context ? { extra: context } : undefined);
  } catch {
    /* ignore */
  }
}

export function reportWarning(message: string, context?: Record<string, unknown>) {
  ensureInit();
  if (!observabilityEnabled) return;
  try {
    Sentry.captureMessage(message, { level: 'warning', extra: context });
  } catch {
    /* ignore */
  }
}

export function installGlobalReporters() {
  ensureInit();
  if (!observabilityEnabled) return;
  // Sentry already wires global error + unhandledrejection; keeping the
  // explicit listeners around so behaviour matches the previous helper:
  window.addEventListener('error', (event) => {
    reportError(event.error ?? event.message, {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, { kind: 'unhandledrejection' });
  });
}

export function setUserContext(user: { id: string | null; email: string | null; role: string | null }) {
  if (!observabilityEnabled) return;
  try {
    Sentry.setUser({
      id: user.id ?? undefined,
      email: user.email ?? undefined,
      role: user.role ?? undefined,
    });
  } catch {
    /* ignore */
  }
}
