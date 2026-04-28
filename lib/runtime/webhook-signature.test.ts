import { describe, expect, it } from 'vitest';
import { computeMetaSignature, safeEqual, verifyMetaSignatureValue } from './webhook-signature';

const SECRET = 'super-secret';
const BODY = JSON.stringify({ entry: [{ id: '1' }] });

describe('safeEqual', () => {
  it('returns true for identical strings', () => {
    expect(safeEqual('abcd', 'abcd')).toBe(true);
  });
  it('returns false for different lengths', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
  it('returns false for different content', () => {
    expect(safeEqual('abcd', 'abce')).toBe(false);
  });
});

describe('verifyMetaSignatureValue', () => {
  it('accepts a correctly computed signature', async () => {
    const sig = await computeMetaSignature(SECRET, BODY);
    expect(await verifyMetaSignatureValue(sig, BODY, SECRET)).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const sig = await computeMetaSignature(SECRET, BODY);
    const tampered = BODY + 'x';
    expect(await verifyMetaSignatureValue(sig, tampered, SECRET)).toBe(false);
  });

  it('rejects a missing or malformed header', async () => {
    expect(await verifyMetaSignatureValue(null, BODY, SECRET)).toBe(false);
    expect(await verifyMetaSignatureValue('not-sha', BODY, SECRET)).toBe(false);
  });

  it('rejects when secret is empty', async () => {
    const sig = await computeMetaSignature(SECRET, BODY);
    expect(await verifyMetaSignatureValue(sig, BODY, '')).toBe(false);
  });
});
