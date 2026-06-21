import { describe, expect, it } from 'vitest';
import { linksForTrack } from './links';

describe('linksForTrack', () => {
  it('always includes the general Karnaf site', () => {
    expect(linksForTrack('program').some((l) => l.url.includes('karnafnadlan.com'))).toBe(true);
    expect(linksForTrack(null).some((l) => l.url.includes('karnafnadlan.com'))).toBe(true);
  });

  it('presale track includes the PT Sinai project page', () => {
    expect(linksForTrack('presale').some((l) => l.url.includes('karnaf-pt-sinai'))).toBe(true);
  });

  it('never exposes a payment/checkout link', () => {
    for (const track of [null, 'program', 'presale', 'investor_mentorship', 'consultation']) {
      for (const l of linksForTrack(track)) {
        expect(l.url.toLowerCase()).not.toMatch(/checkout|payment|pay|slika|sale-link/);
      }
    }
  });
});
