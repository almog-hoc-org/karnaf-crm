// In-memory circuit breaker for outbound calls (model API, WhatsApp provider).
// The state is per-Edge-Function instance; combined with structured logging
// to ai_decisions / integration_logs that's enough to stop bleeding when an
// upstream is degraded without paging on every request.

interface BreakerState {
  failures: number;
  openedAt: number | null;
}

const states = new Map<string, BreakerState>();

export interface BreakerConfig {
  threshold: number;
  cooldownMs: number;
}

export function isOpen(name: string, cfg: BreakerConfig, now = Date.now()): boolean {
  const s = states.get(name);
  if (!s || !s.openedAt) return false;
  if (now - s.openedAt > cfg.cooldownMs) {
    states.set(name, { failures: 0, openedAt: null });
    return false;
  }
  return true;
}

export function recordSuccess(name: string) {
  states.set(name, { failures: 0, openedAt: null });
}

export function recordFailure(name: string, cfg: BreakerConfig, now = Date.now()): boolean {
  const prev = states.get(name) ?? { failures: 0, openedAt: null };
  const failures = prev.failures + 1;
  const openedAt = failures >= cfg.threshold ? prev.openedAt ?? now : null;
  states.set(name, { failures, openedAt });
  return openedAt !== null;
}

