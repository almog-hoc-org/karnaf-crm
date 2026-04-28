import { describe, expect, it } from 'vitest';
import { normalizeIsraeliPhone, toWhatsAppPhone } from './phone';

describe('normalizeIsraeliPhone', () => {
  it('returns null for empty input', () => {
    expect(normalizeIsraeliPhone(null)).toBeNull();
    expect(normalizeIsraeliPhone('')).toBeNull();
  });

  it('strips spaces, hyphens, parentheses, and dots', () => {
    expect(normalizeIsraeliPhone('050-123-4567')).toBe('0501234567');
    expect(normalizeIsraeliPhone('(050) 123 4567')).toBe('0501234567');
    expect(normalizeIsraeliPhone('050.123.4567')).toBe('0501234567');
  });

  it('converts +972 / 00972 / 972 prefixes', () => {
    expect(normalizeIsraeliPhone('+972501234567')).toBe('0501234567');
    expect(normalizeIsraeliPhone('00972501234567')).toBe('0501234567');
    expect(normalizeIsraeliPhone('972501234567')).toBe('0501234567');
  });

  it('prefixes leading zero to bare 9-digit numbers', () => {
    expect(normalizeIsraeliPhone('501234567')).toBe('0501234567');
  });

  it('rejects fragments below 9 digits', () => {
    expect(normalizeIsraeliPhone('12345')).toBeNull();
  });
});

describe('toWhatsAppPhone', () => {
  it('produces 972-prefixed E.164-style strings', () => {
    expect(toWhatsAppPhone('0501234567')).toBe('972501234567');
    expect(toWhatsAppPhone('+972501234567')).toBe('972501234567');
    expect(toWhatsAppPhone('972501234567')).toBe('972501234567');
  });
});
