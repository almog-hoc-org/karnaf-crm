import { describe, expect, it } from 'vitest';
import { isFreeformAllowed, resolveSendMode } from './conversation-window';

const NOW = new Date('2026-04-27T12:00:00Z');

describe('isFreeformAllowed', () => {
  it('returns false when no inbound has been recorded', () => {
    expect(isFreeformAllowed(null, 24, NOW)).toBe(false);
    expect(isFreeformAllowed(undefined, 24, NOW)).toBe(false);
  });

  it('returns true within the configured window', () => {
    const oneHourAgo = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    expect(isFreeformAllowed(oneHourAgo, 24, NOW)).toBe(true);
  });

  it('returns false outside the window', () => {
    const twoDaysAgo = new Date(NOW.getTime() - 48 * 60 * 60 * 1000).toISOString();
    expect(isFreeformAllowed(twoDaysAgo, 24, NOW)).toBe(false);
  });

  it('rejects unparseable timestamps', () => {
    expect(isFreeformAllowed('not-a-date', 24, NOW)).toBe(false);
  });
});

describe('resolveSendMode', () => {
  it('passes through no_send and manual_only as-is', () => {
    expect(resolveSendMode('no_send', null, 24, NOW)).toBe('no_send');
    expect(resolveSendMode('manual_only', null, 24, NOW)).toBe('manual_only');
  });

  it('downgrades freeform to template when window has expired', () => {
    const old = new Date(NOW.getTime() - 48 * 60 * 60 * 1000).toISOString();
    expect(resolveSendMode('freeform', old, 24, NOW)).toBe('template');
  });

  it('keeps freeform when within the window', () => {
    const fresh = new Date(NOW.getTime() - 60 * 1000).toISOString();
    expect(resolveSendMode('freeform', fresh, 24, NOW)).toBe('freeform');
  });
});
