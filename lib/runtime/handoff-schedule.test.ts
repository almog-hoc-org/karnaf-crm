import { describe, expect, it } from 'vitest';
import { buildHumanHandoffSchedule, findNextOpening, isWithinWorkingHours, type HandoffActiveHours } from './handoff-schedule';

const HOURS: HandoffActiveHours = { start: '09:00', end: '21:00', timezone: 'Asia/Jerusalem', workingDays: [0, 1, 2, 3, 4] };

describe('human handoff schedule', () => {
  it('marks weekday daytime as open and urgent', () => {
    const now = new Date('2026-06-07T12:00:00.000Z'); // Sunday 15:00 IL
    const schedule = buildHumanHandoffSchedule(now, HOURS);
    expect(schedule.isOpenNow).toBe(true);
    expect(schedule.priorityLevel).toBe(1);
    expect(schedule.dueAtIso).toBe(now.toISOString());
    expect(schedule.customerText).toContain('בהקדם');
  });

  it('moves late-night handoff to the next morning', () => {
    const now = new Date('2026-06-07T19:30:00.000Z'); // Sunday 22:30 IL
    const schedule = buildHumanHandoffSchedule(now, HOURS);
    expect(schedule.isOpenNow).toBe(false);
    expect(schedule.priorityLevel).toBe(2);
    expect(schedule.customerText).toContain('לא בשעות הפעילות');
    expect(schedule.dueAtIso).toBe('2026-06-08T06:00:00.000Z'); // Monday 09:00 IL
  });

  it('moves Friday handoff to Sunday morning by default', () => {
    const now = new Date('2026-06-12T07:00:00.000Z'); // Friday 10:00 IL
    expect(isWithinWorkingHours(now, HOURS)).toBe(false);
    expect(findNextOpening(now, HOURS).toISOString()).toBe('2026-06-14T06:00:00.000Z'); // Sunday 09:00 IL
  });
});
