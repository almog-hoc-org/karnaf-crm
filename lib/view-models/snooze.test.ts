import { describe, expect, it } from 'vitest';
import { SNOOZE_PRESETS, computeSnoozeUntil, snoozeUntilFromDate } from '@lib/view-models/snooze';

// 2026-08-11T12:00:00Z (a Tuesday noon)
const NOW = Date.parse('2026-08-11T12:00:00.000Z');

describe('computeSnoozeUntil', () => {
  it('lands 3 days out at the 06:00 UTC morning anchor', () => {
    expect(computeSnoozeUntil('3d', NOW)).toBe('2026-08-14T06:00:00.000Z');
  });

  it('covers week/fortnight/month presets', () => {
    expect(computeSnoozeUntil('1w', NOW)).toBe('2026-08-18T06:00:00.000Z');
    expect(computeSnoozeUntil('2w', NOW)).toBe('2026-08-25T06:00:00.000Z');
    expect(computeSnoozeUntil('1m', NOW)).toBe('2026-09-10T06:00:00.000Z');
  });

  it('every preset resolves to a future timestamp', () => {
    for (const { key } of SNOOZE_PRESETS) {
      expect(Date.parse(computeSnoozeUntil(key, NOW))).toBeGreaterThan(NOW);
    }
  });
});

describe('snoozeUntilFromDate', () => {
  it('anchors a picked date to the working morning', () => {
    expect(snoozeUntilFromDate('2026-09-01')).toBe('2026-09-01T06:00:00.000Z');
  });

  it('rejects malformed input', () => {
    expect(snoozeUntilFromDate('01/09/2026')).toBeNull();
    expect(snoozeUntilFromDate('')).toBeNull();
  });
});
