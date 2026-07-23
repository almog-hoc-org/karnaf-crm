import { describe, expect, it } from 'vitest';
import {
  buildFirstTouchUpdates,
  deriveFbc,
  extractAttribution,
} from '@lib/runtime/attribution';

const FULL_PAYLOAD = {
  name: 'ישראל ישראלי',
  phone: '0501234567',
  utm_source: 'facebook',
  utm_medium: 'paid',
  utm_campaign: 'course-july',
  utm_content: 'video-a',
  utm_term: 'mortgage',
  landing_page: '/course',
  page_path: '/course?x=1',
  page_url: 'https://karnafnadlan.com/course',
  referrer: 'https://l.facebook.com/',
  fbclid: 'IwAR123',
  fbp: 'fb.1.1700000000.111',
  fbc: 'fb.1.1700000000.IwAR123',
  event_id: 'evt-abc',
};

describe('extractAttribution', () => {
  it('extracts and sanitizes all attribution fields', () => {
    const attrs = extractAttribution(FULL_PAYLOAD);
    expect(attrs.utm_source).toBe('facebook');
    expect(attrs.utm_campaign).toBe('course-july');
    expect(attrs.landing_page).toBe('/course');
    expect(attrs.referrer).toBe('https://l.facebook.com/');
    expect(attrs.fbclid).toBe('IwAR123');
    expect(attrs.fbp).toBe('fb.1.1700000000.111');
    expect(attrs.event_id).toBe('evt-abc');
    expect(attrs.page_url).toBe('https://karnafnadlan.com/course');
  });

  it('falls back to page_path when landing_page is missing', () => {
    const attrs = extractAttribution({ page_path: '/mortgage' });
    expect(attrs.landing_page).toBe('/mortgage');
  });

  it('returns nulls for missing, empty, or non-string values', () => {
    const attrs = extractAttribution({ utm_source: '  ', utm_medium: 7, fbp: null });
    expect(attrs.utm_source).toBeNull();
    expect(attrs.utm_medium).toBeNull();
    expect(attrs.fbp).toBeNull();
    expect(attrs.utm_campaign).toBeNull();
  });

  it('trims and caps values at 200 chars', () => {
    const attrs = extractAttribution({ utm_campaign: `  ${'x'.repeat(300)}  ` });
    expect(attrs.utm_campaign).toHaveLength(200);
  });
});

describe('deriveFbc', () => {
  it('builds the fb.1.<ts>.<fbclid> format', () => {
    expect(deriveFbc('IwAR123', 1700000000123)).toBe('fb.1.1700000000123.IwAR123');
  });

  it('returns null without an fbclid', () => {
    expect(deriveFbc(null, 1700000000123)).toBeNull();
    expect(deriveFbc('', 1700000000123)).toBeNull();
  });
});

describe('buildFirstTouchUpdates', () => {
  const NOW = '2026-07-23T10:00:00.000Z';

  it('fills all empty columns on first touch and stamps first_touch_at', () => {
    const attrs = extractAttribution(FULL_PAYLOAD);
    const updates = buildFirstTouchUpdates({}, attrs, NOW);
    expect(updates.utm_source).toBe('facebook');
    expect(updates.utm_campaign).toBe('course-july');
    expect(updates.fbc).toBe('fb.1.1700000000.IwAR123');
    expect(updates.first_touch_at).toBe(NOW);
    expect(updates.last_touch).toMatchObject({
      touched_at: NOW,
      utm_campaign: 'course-july',
      page_url: 'https://karnafnadlan.com/course',
    });
  });

  it('never overwrites existing first-touch values', () => {
    const lead = { utm_campaign: 'original', first_touch_at: '2026-01-01T00:00:00Z' };
    const attrs = extractAttribution({ utm_campaign: 'newer', utm_source: 'google' });
    const updates = buildFirstTouchUpdates(lead, attrs, NOW);
    expect(updates.utm_campaign).toBeUndefined();
    expect(updates.first_touch_at).toBeUndefined();
    // Empty columns still fill in.
    expect(updates.utm_source).toBe('google');
    // The newer values are preserved in last_touch.
    expect(updates.last_touch).toMatchObject({ utm_campaign: 'newer' });
  });

  it('records last_touch even when no attribution is present', () => {
    const updates = buildFirstTouchUpdates({}, extractAttribution({}), NOW);
    expect(updates.first_touch_at).toBeUndefined();
    expect(updates.last_touch).toEqual({ touched_at: NOW });
  });
});
