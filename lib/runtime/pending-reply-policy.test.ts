import { describe, expect, it } from 'vitest';
import { pendingReplyDecision } from './pending-reply-policy';

const NOW = new Date('2026-08-16T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('pendingReplyDecision', () => {
  it('sends a fresh, untried reply', () => {
    expect(pendingReplyDecision({ attempts: 0, queued_at: daysAgo(1) }, NOW)).toEqual({ send: true });
  });

  it('stops after the attempt ceiling instead of retrying forever', () => {
    expect(pendingReplyDecision({ attempts: 4, queued_at: daysAgo(1) }, NOW)).toEqual({ send: true });
    expect(pendingReplyDecision({ attempts: 5, queued_at: daysAgo(1) }, NOW))
      .toEqual({ send: false, reason: 'too_many_attempts' });
  });

  it('expires a reply that has been parked too long', () => {
    expect(pendingReplyDecision({ attempts: 0, queued_at: daysAgo(13) }, NOW)).toEqual({ send: true });
    expect(pendingReplyDecision({ attempts: 0, queued_at: daysAgo(15) }, NOW))
      .toEqual({ send: false, reason: 'too_old' });
  });

  it('treats a missing or unparseable timestamp as not-expired', () => {
    expect(pendingReplyDecision({ attempts: 0, queued_at: null }, NOW)).toEqual({ send: true });
    expect(pendingReplyDecision({ attempts: 0, queued_at: 'nope' }, NOW)).toEqual({ send: true });
  });

  it('defaults a missing attempts column to zero', () => {
    expect(pendingReplyDecision({ queued_at: daysAgo(1) }, NOW)).toEqual({ send: true });
  });
});
