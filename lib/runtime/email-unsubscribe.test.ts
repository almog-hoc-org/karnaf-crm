import { describe, expect, it } from 'vitest';
import { signingSecrets, tokenFor, unsubscribeHeaders, verifyToken } from './email-unsubscribe';

const LEAD_A = '11111111-1111-4111-8111-111111111111';
const LEAD_B = '22222222-2222-4222-8222-222222222222';

describe('unsubscribe token', () => {
  it('round-trips for the same lead and secret', async () => {
    const token = await tokenFor('s3cret', LEAD_A);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(await verifyToken(['s3cret'], LEAD_A, token)).toBe(true);
    // Upper-case (some mail clients rewrite URLs) still passes.
    expect(await verifyToken(['s3cret'], LEAD_A, token.toUpperCase())).toBe(true);
  });

  it('rejects another lead, another secret, a truncated or empty token', async () => {
    const token = await tokenFor('s3cret', LEAD_A);
    expect(await verifyToken(['s3cret'], LEAD_B, token)).toBe(false);
    expect(await verifyToken(['other'], LEAD_A, token)).toBe(false);
    expect(await verifyToken(['s3cret'], LEAD_A, token.slice(0, 31))).toBe(false);
    expect(await verifyToken(['s3cret'], LEAD_A, '')).toBe(false);
    expect(await verifyToken(['s3cret'], '', token)).toBe(false);
    expect(await verifyToken([], LEAD_A, token)).toBe(false);
  });

  it('keeps links signed with the legacy secret valid after a dedicated secret is introduced', async () => {
    const legacyToken = await tokenFor('service-role-key', LEAD_A);
    const secrets = signingSecrets('new-dedicated-secret', 'service-role-key');
    expect(secrets).toEqual(['new-dedicated-secret', 'service-role-key']);
    expect(await verifyToken(secrets, LEAD_A, legacyToken)).toBe(true);
    expect(await verifyToken(secrets, LEAD_A, await tokenFor('new-dedicated-secret', LEAD_A))).toBe(true);
  });

  it('drops empty and duplicate secrets', () => {
    expect(signingSecrets(undefined, 'k')).toEqual(['k']);
    expect(signingSecrets('k', 'k')).toEqual(['k']);
    expect(signingSecrets(null, null)).toEqual([]);
  });

  it('emits RFC 8058 one-click headers', () => {
    expect(unsubscribeHeaders('https://x/u?l=1&t=2')).toEqual({
      'List-Unsubscribe': '<https://x/u?l=1&t=2>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });
});
