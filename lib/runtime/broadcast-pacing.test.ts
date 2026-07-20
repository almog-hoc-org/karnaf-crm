import { describe, expect, it } from 'vitest';
import { DEFAULT_PACING, enqueueAllowance, resolvePacing, shouldPauseBroadcast } from './broadcast-pacing';

describe('resolvePacing', () => {
  it('falls back to defaults on missing/invalid config', () => {
    expect(resolvePacing(null)).toEqual(DEFAULT_PACING);
    expect(resolvePacing({ per_tick: -5, daily_cap: 'x' })).toEqual(DEFAULT_PACING);
  });

  it('honors explicit overrides', () => {
    const p = resolvePacing({ per_tick: 5, daily_cap: 100, pause_min_sample: 10, pause_failure_pct: 50 });
    expect(p).toEqual({ perTick: 5, dailyCap: 100, pauseMinSample: 10, pauseFailurePct: 50 });
  });
});

describe('enqueueAllowance', () => {
  it('is capped by per-tick rate when the day is fresh', () => {
    expect(enqueueAllowance(DEFAULT_PACING, 0)).toBe(20);
  });

  it('shrinks as the rolling-24h spend approaches the daily cap', () => {
    expect(enqueueAllowance(DEFAULT_PACING, 240)).toBe(10);
    expect(enqueueAllowance(DEFAULT_PACING, 250)).toBe(0);
    expect(enqueueAllowance(DEFAULT_PACING, 400)).toBe(0);
  });
});

describe('shouldPauseBroadcast', () => {
  it('never pauses below the minimum sample', () => {
    expect(shouldPauseBroadcast(DEFAULT_PACING, 0, 19)).toBe(false);
  });

  it('pauses once the failure rate crosses the threshold', () => {
    expect(shouldPauseBroadcast(DEFAULT_PACING, 14, 6)).toBe(true); // 30%
    expect(shouldPauseBroadcast(DEFAULT_PACING, 18, 2)).toBe(false); // 10%
  });
});
