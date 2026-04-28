import { describe, expect, it } from 'vitest';
import { containsForbiddenClaim } from './forbidden-claims';

const CLAIMS = ['תשואה מובטחת', 'מבטיח רווח', 'guaranteed return'];

describe('containsForbiddenClaim', () => {
  it('returns null when no match', () => {
    expect(containsForbiddenClaim('שלום, איך אפשר לעזור?', CLAIMS)).toBeNull();
  });

  it('detects an exact Hebrew claim', () => {
    expect(containsForbiddenClaim('יש פה תשואה מובטחת לחלוטין', CLAIMS)).toBe('תשואה מובטחת');
  });

  it('is case-insensitive in English', () => {
    expect(containsForbiddenClaim('We deliver Guaranteed Return!', CLAIMS)).toBe('guaranteed return');
  });

  it('returns null for empty reply', () => {
    expect(containsForbiddenClaim('', CLAIMS)).toBeNull();
  });

  it('skips empty entries in the list', () => {
    expect(containsForbiddenClaim('שלום', ['', ' '])).toBeNull();
  });
});
