// Broadcast pacing + quality guard. Pure decision logic — mirrored in
// lib/runtime/broadcast-pacing.ts for unit tests; keep in sync.
//
// Three protections against WhatsApp number blocking:
//   1. per-tick rate — spreads a large broadcast over minutes,
//   2. daily cap — stays under Meta's rolling-24h messaging-limit tier,
//   3. auto-pause — if Meta starts rejecting sends, stop before the
//      number's quality rating takes the hit.

export interface BroadcastPacing {
  perTick: number;
  dailyCap: number;
  pauseMinSample: number;
  pauseFailurePct: number;
}

export const DEFAULT_PACING: BroadcastPacing = {
  perTick: 20,
  dailyCap: 250,
  pauseMinSample: 20,
  pauseFailurePct: 30,
};

export function resolvePacing(raw: unknown): BroadcastPacing {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  return {
    perTick: num(cfg.per_tick, DEFAULT_PACING.perTick),
    dailyCap: num(cfg.daily_cap, DEFAULT_PACING.dailyCap),
    pauseMinSample: num(cfg.pause_min_sample, DEFAULT_PACING.pauseMinSample),
    pauseFailurePct: num(cfg.pause_failure_pct, DEFAULT_PACING.pauseFailurePct),
  };
}

/** How many recipients may be enqueued this tick, given the rolling-24h spend. */
export function enqueueAllowance(pacing: BroadcastPacing, enqueuedLast24h: number): number {
  return Math.max(0, Math.min(pacing.perTick, pacing.dailyCap - enqueuedLast24h));
}

/** True when the provider failure rate says: stop now, protect the number. */
export function shouldPauseBroadcast(pacing: BroadcastPacing, sent: number, failed: number): boolean {
  const attempted = sent + failed;
  if (attempted < pacing.pauseMinSample) return false;
  return (failed / attempted) * 100 >= pacing.pauseFailurePct;
}
