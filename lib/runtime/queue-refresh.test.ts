import { describe, expect, it } from 'vitest';
import { buildQueueRefreshPatch } from '@lib/runtime/queue-refresh';

const NOW = '2026-08-11T10:00:00.000Z';
const EXISTING = {
  priority_level: 2,
  due_at: '2026-08-01T08:00:00.000Z',
  reason: 'ישן',
  queue_summary: 'סיכום ישן',
};

describe('buildQueueRefreshPatch', () => {
  it('always stamps last_signal_at and the new reason', () => {
    const patch = buildQueueRefreshPatch(EXISTING, {
      priorityLevel: 2,
      reason: 'הלקוח כתב שוב',
      nowIso: NOW,
    });
    expect(patch.last_signal_at).toBe(NOW);
    expect(patch.reason).toBe('הלקוח כתב שוב');
    expect(patch.due_at).toBeUndefined();
    expect(patch.queue_summary).toBeUndefined();
  });

  it('updates due_at and queue_summary when the new signal carries them', () => {
    const patch = buildQueueRefreshPatch(EXISTING, {
      priorityLevel: 2,
      dueAt: NOW,
      reason: 'r',
      queueSummary: 'הודעה חדשה מהלקוח',
      nowIso: NOW,
    });
    expect(patch.due_at).toBe(NOW);
    expect(patch.queue_summary).toBe('הודעה חדשה מהלקוח');
  });

  it('escalates priority but never de-escalates', () => {
    expect(
      buildQueueRefreshPatch(EXISTING, { priorityLevel: 1, reason: 'r', nowIso: NOW }).priority_level,
    ).toBe(1);
    expect(
      buildQueueRefreshPatch(EXISTING, { priorityLevel: 3, reason: 'r', nowIso: NOW }).priority_level,
    ).toBeUndefined();
  });
});
