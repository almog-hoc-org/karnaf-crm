import { describe, expect, it } from 'vitest';
import { resolveTrackContext, TRACKS } from './track-context';

describe('resolveTrackContext', () => {
  it('routes presale primary_track to the presale project context', () => {
    const t = resolveTrackContext('presale', null);
    expect(t.code).toBe('presale');
    expect(t.statesPricing).toBe(false);
    expect(t.displayName).toContain('פתח תקווה');
  });

  it('routes investor_mentorship track', () => {
    expect(resolveTrackContext('investor_mentorship', null).code).toBe('investor_mentorship');
  });

  it('falls back to flagship program when track is missing/unknown', () => {
    expect(resolveTrackContext(null, null).code).toBe('program');
    expect(resolveTrackContext('something_else', null).code).toBe('program');
  });

  it('uses product_interest as a soft fallback when primary_track is absent', () => {
    expect(resolveTrackContext(null, 'investor_mentorship').code).toBe('investor_mentorship');
    expect(resolveTrackContext(null, 'contractor_group_purchase').code).toBe('presale');
  });

  it('only the flagship program may state pricing', () => {
    expect(TRACKS.program.statesPricing).toBe(true);
    expect(TRACKS.presale.statesPricing).toBe(false);
    expect(TRACKS.investor_mentorship.statesPricing).toBe(false);
  });

  it('personal_consultation resolves to a neutral consultation context, NOT the flagship', () => {
    const t = resolveTrackContext(null, 'personal_consultation');
    expect(t.code).toBe('consultation');
    expect(t.code).not.toBe('program');
    expect(t.statesPricing).toBe(false);
  });

  it('an established primary_track wins over a later consultation interest (sticky — regression)', () => {
    // The live-test failure: mentorship lead later asked about a consultation and got bounced to flagship.
    expect(resolveTrackContext('investor_mentorship', 'personal_consultation').code).toBe('investor_mentorship');
    expect(resolveTrackContext('presale', 'personal_consultation').code).toBe('presale');
  });
});
