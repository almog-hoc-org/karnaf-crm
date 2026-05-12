import { describe, expect, it } from 'vitest';
import { resolveMaxReplyChars } from './reply-length';

describe('resolveMaxReplyChars', () => {
  it('returns base for warm heat', () => {
    expect(resolveMaxReplyChars('warm', 900)).toBe(900);
  });

  it('boosts for hot heat', () => {
    expect(resolveMaxReplyChars('hot', 900)).toBeGreaterThan(900);
  });

  it('shortens for cold/dormant heat', () => {
    expect(resolveMaxReplyChars('cold', 900)).toBeLessThan(900);
    expect(resolveMaxReplyChars('dormant', 900)).toBeLessThan(900);
  });

  it('case-insensitive heat lookup', () => {
    expect(resolveMaxReplyChars('HOT', 900)).toBe(resolveMaxReplyChars('hot', 900));
  });

  it('defaults to warm multiplier when heat is null/unknown', () => {
    expect(resolveMaxReplyChars(null, 900)).toBe(900);
    expect(resolveMaxReplyChars('bizarre', 900)).toBe(900);
  });

  it('enforces hard floor', () => {
    expect(resolveMaxReplyChars('cold', 100)).toBeGreaterThanOrEqual(200);
  });

  it('enforces hard ceiling', () => {
    expect(resolveMaxReplyChars('hot', 5000)).toBeLessThanOrEqual(2000);
  });

  it('handles invalid base by returning floor', () => {
    expect(resolveMaxReplyChars('warm', 0)).toBe(200);
    expect(resolveMaxReplyChars('warm', -50)).toBe(200);
  });
});
