import { describe, expect, it } from 'vitest';
import {
  buildTimeContext,
  formatTimeContextForPrompt,
} from './time-context';

const HOURS = { start: '09:00', end: '21:00', timezone: 'Asia/Jerusalem' };

describe('buildTimeContext', () => {
  it('flags business hours during weekday afternoon', () => {
    const wednesdayNoonIL = new Date('2026-05-13T11:00:00.000Z');
    const ctx = buildTimeContext({
      now: wednesdayNoonIL,
      lastInboundAt: null,
      activeHours: HOURS,
    });
    expect(ctx.dayOfWeek).toBe('Wednesday');
    expect(ctx.isBusinessHours).toBe(true);
    expect(ctx.isAfterHours).toBe(false);
    expect(ctx.isWeekend).toBe(false);
    expect(ctx.minutesSinceLastInbound).toBeNull();
    expect(ctx.idleBucket).toBeNull();
  });

  it('flags after-hours late night', () => {
    const wednesday22IL = new Date('2026-05-13T19:30:00.000Z');
    const ctx = buildTimeContext({
      now: wednesday22IL,
      lastInboundAt: null,
      activeHours: HOURS,
    });
    expect(ctx.isBusinessHours).toBe(false);
    expect(ctx.isAfterHours).toBe(true);
  });

  it('flags weekend Saturday in Israel timezone', () => {
    const saturdayNoon = new Date('2026-05-16T09:00:00.000Z');
    const ctx = buildTimeContext({
      now: saturdayNoon,
      lastInboundAt: null,
      activeHours: HOURS,
    });
    expect(ctx.dayOfWeek).toBe('Saturday');
    expect(ctx.isWeekend).toBe(true);
  });

  it('buckets idle time correctly', () => {
    const now = new Date('2026-05-13T12:00:00.000Z');
    const fresh = buildTimeContext({
      now,
      lastInboundAt: new Date(now.getTime() - 2 * 60_000).toISOString(),
      activeHours: HOURS,
    });
    expect(fresh.idleBucket).toBe('fresh');

    const short = buildTimeContext({
      now,
      lastInboundAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
      activeHours: HOURS,
    });
    expect(short.idleBucket).toBe('short');

    const medium = buildTimeContext({
      now,
      lastInboundAt: new Date(now.getTime() - 2 * 60 * 60_000).toISOString(),
      activeHours: HOURS,
    });
    expect(medium.idleBucket).toBe('medium');

    const long = buildTimeContext({
      now,
      lastInboundAt: new Date(now.getTime() - 12 * 60 * 60_000).toISOString(),
      activeHours: HOURS,
    });
    expect(long.idleBucket).toBe('long');

    const cold = buildTimeContext({
      now,
      lastInboundAt: new Date(now.getTime() - 3 * 24 * 60 * 60_000).toISOString(),
      activeHours: HOURS,
    });
    expect(cold.idleBucket).toBe('cold');
  });

  it('handles malformed lastInboundAt as null', () => {
    const ctx = buildTimeContext({
      now: new Date('2026-05-13T11:00:00.000Z'),
      lastInboundAt: 'not-a-date',
      activeHours: HOURS,
    });
    expect(ctx.minutesSinceLastInbound).toBeNull();
    expect(ctx.idleBucket).toBeNull();
  });

  it('supports start>end overnight active hours', () => {
    const nightShift = { start: '22:00', end: '06:00', timezone: 'Asia/Jerusalem' };
    const ctx1am = buildTimeContext({
      now: new Date('2026-05-13T22:00:00.000Z'),
      lastInboundAt: null,
      activeHours: nightShift,
    });
    expect(ctx1am.isBusinessHours).toBe(true);
  });
});

describe('formatTimeContextForPrompt', () => {
  it('emits 3 lines with idle info when minutesSinceLastInbound present', () => {
    const ctx = buildTimeContext({
      now: new Date('2026-05-13T11:00:00.000Z'),
      lastInboundAt: '2026-05-13T10:30:00.000Z',
      activeHours: HOURS,
    });
    const lines = formatTimeContextForPrompt(ctx, HOURS.timezone);
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).toContain('Asia/Jerusalem');
    expect(lines.join('\n')).toContain('idle bucket');
  });

  it('notes first contact when no prior inbound', () => {
    const ctx = buildTimeContext({
      now: new Date('2026-05-13T11:00:00.000Z'),
      lastInboundAt: null,
      activeHours: HOURS,
    });
    const lines = formatTimeContextForPrompt(ctx, HOURS.timezone);
    expect(lines.join('\n')).toContain('first contact');
  });
});
