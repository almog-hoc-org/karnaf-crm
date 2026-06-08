import { describe, expect, it } from 'vitest';
import {
  HEAT_LABELS,
  OWNERSHIP_LABELS,
  QUEUE_LABELS,
  STATUS_LABELS,
  formatDateTime,
  formatRelative,
  heatBadgeClass,
} from './format';

describe('label catalogs', () => {
  it('covers every LeadStatus literal', () => {
    const statuses = [
      'new', 'first_contact_sent', 'responded', 'qualified', 'nurture',
      'checkout_pushed', 'payment_pending', 'human_handoff', 'won', 'lost',
      'dormant', 'onboarding_active', 'active_student', 'do_not_contact',
      'removed_by_request', 'duplicate', 'manual_review_required',
    ] as const;
    for (const s of statuses) {
      expect(STATUS_LABELS[s]).toBeTruthy();
    }
  });

  it('covers every LeadHeat tier', () => {
    expect(HEAT_LABELS.hot).toBe('חם');
    expect(HEAT_LABELS.warm).toBe('פושר');
    expect(HEAT_LABELS.cool).toBe('צונן');
    expect(HEAT_LABELS.cold).toBe('קר');
  });

  it('covers every OwnershipMode', () => {
    expect(OWNERSHIP_LABELS.ai_active).toBeTruthy();
    expect(OWNERSHIP_LABELS.mia_active).toBeTruthy();
    expect(OWNERSHIP_LABELS.phone_sales_pending).toBeTruthy();
    expect(OWNERSHIP_LABELS.shared_watch).toBeTruthy();
    expect(OWNERSHIP_LABELS.suppressed).toBeTruthy();
  });

  it('covers the operator queue types we surface in the UI', () => {
    expect(QUEUE_LABELS.first_response_due).toBeTruthy();
    expect(QUEUE_LABELS.hot_lead).toBeTruthy();
    expect(QUEUE_LABELS.payment_pending).toBeTruthy();
    expect(QUEUE_LABELS.manual_review_required).toBeTruthy();
  });

  it('keeps displayed Hebrew labels readable and not mojibake', () => {
    const labels = [
      ...Object.values(STATUS_LABELS),
      ...Object.values(HEAT_LABELS),
      ...Object.values(OWNERSHIP_LABELS),
      ...Object.values(QUEUE_LABELS),
    ];

    for (const label of labels) {
      expect(label).toMatch(/[א-ת]/);
      expect(label).not.toMatch(new RegExp(`${String.fromCharCode(0xfffd)}|\\?{2,}|\\?[Tcx~]\\?`));
    }
  });
});

describe('heatBadgeClass', () => {
  it('maps known tiers to the matching tone classes', () => {
    expect(heatBadgeClass('hot')).toBe('kf-badge kf-badge-hot');
    expect(heatBadgeClass('warm')).toBe('kf-badge kf-badge-warm');
    expect(heatBadgeClass('cool')).toBe('kf-badge kf-badge-cool');
    expect(heatBadgeClass('cold')).toBe('kf-badge kf-badge-cold');
  });

  it('falls back to the muted tone for unknown values', () => {
    expect(heatBadgeClass('unknown')).toBe('kf-badge kf-badge-mute');
    expect(heatBadgeClass('')).toBe('kf-badge kf-badge-mute');
  });
});

describe('formatDateTime', () => {
  it('returns an em dash for nullish or unparseable input', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatDateTime('')).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
  });

  it('formats a real ISO timestamp into a non-empty Hebrew locale string', () => {
    const out = formatDateTime('2026-04-27T12:34:56Z');
    expect(out).not.toBe('—');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('formatRelative', () => {
  const NOW = Date.parse('2026-04-27T12:00:00Z');

  it('returns a dash for nullish or invalid input', () => {
    expect(formatRelative(null, NOW)).toBe('—');
    expect(formatRelative(undefined, NOW)).toBe('—');
    expect(formatRelative('not-a-date', NOW)).toBe('—');
  });

  it('returns "הרגע" for sub-minute deltas', () => {
    const tenSecAgo = new Date(NOW - 10 * 1000).toISOString();
    expect(formatRelative(tenSecAgo, NOW)).toBe('הרגע');
  });

  it('returns minutes for sub-hour deltas', () => {
    const fiveMinAgo = new Date(NOW - 5 * 60 * 1000).toISOString();
    expect(formatRelative(fiveMinAgo, NOW)).toBe('לפני 5 ד׳');
  });

  it('returns hours for sub-day deltas', () => {
    const threeHoursAgo = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
    expect(formatRelative(threeHoursAgo, NOW)).toBe('לפני 3 שעות');
  });

  it('returns days for older deltas', () => {
    const twoDaysAgo = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelative(twoDaysAgo, NOW)).toBe('לפני 2 ימים');
  });
});
