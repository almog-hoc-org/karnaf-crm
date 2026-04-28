import { describe, expect, it } from 'vitest';
import { clientIdentifier } from './client-identifier';

function headers(map: Record<string, string>): Pick<Headers, 'get'> {
  return { get: (key: string) => map[key.toLowerCase()] ?? null };
}

describe('clientIdentifier', () => {
  it('prefers Cloudflare-Connecting-IP', () => {
    expect(clientIdentifier(headers({
      'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-for': '198.51.100.1',
      'x-real-ip': '10.0.0.1',
    }))).toBe('203.0.113.7');
  });

  it('falls back to the first entry in X-Forwarded-For', () => {
    expect(clientIdentifier(headers({
      'x-forwarded-for': '198.51.100.1, 10.0.0.1, 10.0.0.2',
    }))).toBe('198.51.100.1');
  });

  it('trims whitespace inside X-Forwarded-For', () => {
    expect(clientIdentifier(headers({
      'x-forwarded-for': '  198.51.100.42  ',
    }))).toBe('198.51.100.42');
  });

  it('falls back to X-Real-IP', () => {
    expect(clientIdentifier(headers({
      'x-real-ip': '203.0.113.99',
    }))).toBe('203.0.113.99');
  });

  it('returns "unknown" when no header is present', () => {
    expect(clientIdentifier(headers({}))).toBe('unknown');
  });
});
