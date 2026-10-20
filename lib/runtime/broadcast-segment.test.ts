import { describe, expect, it } from 'vitest';
import { applySegment, CLOSED_STATUSES, splitSegmentValue } from './broadcast-segment';

type Call = [string, ...unknown[]];

// A query builder that records every filter it is asked for.
function recorder() {
  const calls: Call[] = [];
  const q: Record<string, unknown> = {};
  for (const m of ['eq', 'neq', 'not', 'or', 'in', 'overlaps', 'is']) {
    q[m] = (...args: unknown[]) => { calls.push([m, ...args]); return q; };
  }
  return { q, calls };
}

const NOW = new Date('2026-10-17T10:00:00.000Z');

function has(calls: Call[], call: Call): boolean {
  return calls.some((c) => JSON.stringify(c) === JSON.stringify(call));
}

describe('applySegment — suppression guards', () => {
  it('always excludes DNC, removal, no-proactive, active snooze and closed/stop statuses', () => {
    const { q, calls } = recorder();
    applySegment(q, {}, { now: NOW });
    expect(has(calls, ['eq', 'do_not_contact', false])).toBe(true);
    expect(has(calls, ['eq', 'removed_by_request', false])).toBe(true);
    expect(has(calls, ['eq', 'no_proactive_contact', false])).toBe(true);
    expect(has(calls, ['or', `snoozed_until.is.null,snoozed_until.lte.${NOW.toISOString()}`])).toBe(true);
    const statusCall = calls.find((c) => c[0] === 'not' && c[1] === 'lead_status');
    expect(statusCall?.[2]).toBe('in');
    for (const s of ['won', 'lost', 'duplicate', 'do_not_contact', 'removed_by_request']) {
      expect(String(statusCall?.[3])).toContain(`"${s}"`);
      expect(CLOSED_STATUSES).toContain(s);
    }
  });

  it('WhatsApp (default): needs a phone and excludes an explicit WhatsApp refusal, keeping NULL', () => {
    const { q, calls } = recorder();
    applySegment(q, {}, { now: NOW });
    expect(has(calls, ['not', 'phone', 'is', null])).toBe(true);
    expect(has(calls, ['not', 'consent_whatsapp', 'is', false])).toBe(true);
    expect(calls.some((c) => c[1] === 'consent_email')).toBe(false);
  });
});

describe('applySegment — email consent (חוק הספאם)', () => {
  it('requireEmailConsent default: opt-in only, and an explicit refusal is excluded', () => {
    const { q, calls } = recorder();
    applySegment(q, {}, { channel: 'email', now: NOW });
    expect(has(calls, ['not', 'email', 'is', null])).toBe(true);
    expect(has(calls, ['not', 'consent_email', 'is', false])).toBe(true);
    expect(has(calls, ['eq', 'consent_email', true])).toBe(true);
  });

  it('requireEmailConsent true behaves like the default', () => {
    const { q, calls } = recorder();
    applySegment(q, {}, { channel: 'email', requireEmailConsent: true, now: NOW });
    expect(has(calls, ['eq', 'consent_email', true])).toBe(true);
    expect(has(calls, ['not', 'consent_email', 'is', false])).toBe(true);
  });

  it('requireEmailConsent false admits the never-asked (NULL) but STILL excludes consent_email = false', () => {
    const { q, calls } = recorder();
    applySegment(q, {}, { channel: 'email', requireEmailConsent: false, now: NOW });
    expect(has(calls, ['eq', 'consent_email', true])).toBe(false);
    // The regression this guards: unticking "require consent" used to
    // re-admit everyone who had clicked the unsubscribe link.
    expect(has(calls, ['not', 'consent_email', 'is', false])).toBe(true);
  });
});

describe('applySegment — segment fields', () => {
  it('maps a single value to eq and a comma-joined value to in, ignoring unknown fields', () => {
    const { q, calls } = recorder();
    applySegment(q, { source: 'website,landing_page', primary_track: 'program', evil: 'x' } as never, { now: NOW });
    expect(has(calls, ['in', 'source', ['website', 'landing_page']])).toBe(true);
    expect(has(calls, ['eq', 'primary_track', 'program'])).toBe(true);
    expect(calls.some((c) => c[1] === 'evil')).toBe(false);
  });

  it('matches tags by overlap, trimmed and capped at 20', () => {
    const { q, calls } = recorder();
    const tags = Array.from({ length: 25 }, (_, i) => ` t${i} `);
    applySegment(q, { tags }, { now: NOW });
    const overlap = calls.find((c) => c[0] === 'overlaps');
    expect(overlap?.[1]).toBe('tags');
    expect((overlap?.[2] as string[]).length).toBe(20);
    expect((overlap?.[2] as string[])[0]).toBe('t0');
  });

  it('splitSegmentValue trims and drops empties', () => {
    expect(splitSegmentValue(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
  });
});
