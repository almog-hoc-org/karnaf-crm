import { describe, expect, it } from 'vitest';
import { coveredByLatestReply, latestInboundAt, type GuardMessage } from './answered-guard';

const msg = (
  direction: string,
  created_at: string,
  raw_payload?: Record<string, unknown> | null,
): GuardMessage => ({ direction, created_at, raw_payload });

describe('latestInboundAt', () => {
  it('returns the newest inbound timestamp', () => {
    const ordered = [
      msg('inbound', '2026-07-06T10:00:00Z'),
      msg('outbound', '2026-07-06T10:01:00Z'),
      msg('inbound', '2026-07-06T10:02:00Z'),
    ];
    expect(latestInboundAt(ordered)).toBe('2026-07-06T10:02:00Z');
  });

  it('returns null when there is no inbound', () => {
    expect(latestInboundAt([msg('outbound', '2026-07-06T10:00:00Z')])).toBeNull();
    expect(latestInboundAt([])).toBeNull();
  });
});

describe('coveredByLatestReply', () => {
  it('does not skip when the latest message is inbound', () => {
    const ordered = [
      msg('outbound', '2026-07-06T10:00:00Z'),
      msg('inbound', '2026-07-06T10:01:00Z'),
    ];
    expect(coveredByLatestReply(ordered)).toBe(false);
  });

  it('does not skip on an empty snapshot', () => {
    expect(coveredByLatestReply([])).toBe(false);
  });

  it('skips when the reply marker covers the newest inbound', () => {
    const ordered = [
      msg('inbound', '2026-07-06T10:00:00Z'),
      msg('outbound', '2026-07-06T10:01:00Z', { context_last_inbound_at: '2026-07-06T10:00:00Z' }),
    ];
    expect(coveredByLatestReply(ordered)).toBe(true);
  });

  it('does NOT skip in the mid-flight race: inbound newer than the reply context', () => {
    // msg2 arrived while turn-1's LLM call was in flight — the reply's
    // created_at is later than msg2 but its context only saw msg1.
    const ordered = [
      msg('inbound', '2026-07-06T10:00:00Z'), // msg1
      msg('inbound', '2026-07-06T10:00:30Z'), // msg2 (unseen by the reply)
      msg('outbound', '2026-07-06T10:01:00Z', { context_last_inbound_at: '2026-07-06T10:00:00Z' }),
    ];
    expect(coveredByLatestReply(ordered)).toBe(false);
  });

  it('skips for legacy outbound rows without a marker', () => {
    const ordered = [
      msg('inbound', '2026-07-06T10:00:00Z'),
      msg('outbound', '2026-07-06T10:01:00Z'),
    ];
    expect(coveredByLatestReply(ordered)).toBe(true);
  });

  it('skips for an outbound-only window', () => {
    const ordered = [
      msg('outbound', '2026-07-06T10:00:00Z'),
      msg('outbound', '2026-07-06T10:01:00Z', { context_last_inbound_at: null }),
    ];
    expect(coveredByLatestReply(ordered)).toBe(true);
  });

  it('falls back to skipping when the marker is malformed', () => {
    const ordered = [
      msg('inbound', '2026-07-06T10:00:00Z'),
      msg('outbound', '2026-07-06T10:01:00Z', { context_last_inbound_at: 'not-a-date' }),
    ];
    expect(coveredByLatestReply(ordered)).toBe(true);
  });
});
