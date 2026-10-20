import { describe, expect, it } from 'vitest';
import { hmacHex, verifyAnyBearer, verifyBearer, verifyHmacHeader, verifyMetaSignature } from './webhook-signature';

const BODY = '{"entry":[{"id":"1"}]}';
const SECRET = 'app-secret';

function req(headers: Record<string, string>): Request {
  return new Request('https://x.test/hook', { method: 'POST', headers, body: BODY });
}

describe('verifyMetaSignature (request-based, as shipped)', () => {
  it('accepts the sha256= header Meta sends, case-insensitively', async () => {
    const hex = await hmacHex(SECRET, BODY);
    expect(await verifyMetaSignature(req({ 'x-hub-signature-256': `sha256=${hex}` }), BODY, SECRET)).toBe(true);
    expect(await verifyMetaSignature(req({ 'X-Hub-Signature-256': `sha256=${hex.toUpperCase()}` }), BODY, SECRET)).toBe(true);
  });

  it('rejects a missing prefix, a wrong secret, a tampered body and an empty secret', async () => {
    const hex = await hmacHex(SECRET, BODY);
    expect(await verifyMetaSignature(req({ 'x-hub-signature-256': hex }), BODY, SECRET)).toBe(false);
    expect(await verifyMetaSignature(req({ 'x-hub-signature-256': `sha256=${hex}` }), BODY, 'other')).toBe(false);
    expect(await verifyMetaSignature(req({ 'x-hub-signature-256': `sha256=${hex}` }), BODY + ' ', SECRET)).toBe(false);
    expect(await verifyMetaSignature(req({ 'x-hub-signature-256': `sha256=${hex}` }), BODY, '')).toBe(false);
    expect(await verifyMetaSignature(req({}), BODY, SECRET)).toBe(false);
  });
});

describe('verifyHmacHeader', () => {
  it('accepts a bare hex digest and the GitHub-style sha256= prefix', async () => {
    const hex = await hmacHex(SECRET, BODY);
    expect(await verifyHmacHeader(req({ 'x-karnaf-signature': hex }), BODY, SECRET, 'x-karnaf-signature')).toBe(true);
    expect(await verifyHmacHeader(req({ 'x-karnaf-signature': `sha256=${hex}` }), BODY, SECRET, 'x-karnaf-signature')).toBe(true);
    expect(await verifyHmacHeader(req({ 'x-karnaf-signature': ` ${hex.toUpperCase()} ` }), BODY, SECRET, 'x-karnaf-signature')).toBe(true);
  });

  it('tries the header names in order and uses the first one present', async () => {
    const hex = await hmacHex(SECRET, BODY);
    expect(await verifyHmacHeader(req({ 'x-signature': hex }), BODY, SECRET, ['x-karnaf-signature', 'x-signature'])).toBe(true);
    // An empty first header does not shadow a valid second one.
    expect(await verifyHmacHeader(req({ 'x-karnaf-signature': '', 'x-signature': hex }), BODY, SECRET, ['x-karnaf-signature', 'x-signature'])).toBe(true);
  });

  it('rejects when the header is absent, the digest is wrong, or the secret is empty', async () => {
    const hex = await hmacHex(SECRET, BODY);
    expect(await verifyHmacHeader(req({}), BODY, SECRET, 'x-karnaf-signature')).toBe(false);
    expect(await verifyHmacHeader(req({ 'x-karnaf-signature': hex.slice(1) + '0' }), BODY, SECRET, 'x-karnaf-signature')).toBe(false);
    expect(await verifyHmacHeader(req({ 'x-karnaf-signature': hex }), BODY, '', 'x-karnaf-signature')).toBe(false);
  });
});

describe('verifyBearer', () => {
  it('matches only an exact Bearer token', () => {
    expect(verifyBearer(req({ authorization: 'Bearer s3cret' }), 's3cret')).toBe(true);
    expect(verifyBearer(req({ Authorization: 'bearer s3cret ' }), 's3cret')).toBe(true);
    expect(verifyBearer(req({ authorization: 'Bearer s3cre' }), 's3cret')).toBe(false);
    expect(verifyBearer(req({ authorization: 'Basic s3cret' }), 's3cret')).toBe(false);
    expect(verifyBearer(req({}), 's3cret')).toBe(false);
    expect(verifyBearer(req({ authorization: 'Bearer ' }), '')).toBe(false);
  });
});

describe('verifyAnyBearer', () => {
  it('accepts the dedicated secret and the shared worker secret alike', () => {
    expect(verifyAnyBearer(req({ authorization: 'Bearer dedicated' }), ['dedicated', 'shared'])).toBe(true);
    expect(verifyAnyBearer(req({ authorization: 'Bearer shared' }), ['dedicated', 'shared'])).toBe(true);
    expect(verifyAnyBearer(req({ authorization: 'Bearer other' }), ['dedicated', 'shared'])).toBe(false);
  });

  it('never matches an unset secret or an empty header', () => {
    expect(verifyAnyBearer(req({ authorization: 'Bearer ' }), ['', undefined, null])).toBe(false);
    expect(verifyAnyBearer(req({}), ['shared'])).toBe(false);
    expect(verifyAnyBearer(req({ authorization: 'Bearer shared' }), [undefined, 'shared'])).toBe(true);
  });
});
