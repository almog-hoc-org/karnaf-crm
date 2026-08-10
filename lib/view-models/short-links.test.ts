import { describe, expect, it } from 'vitest';
import { SHORT_LINKS, resolveShortLink } from '@lib/view-models/short-links';

describe('resolveShortLink', () => {
  it('resolves the investors link to the division WhatsApp with prefilled text', () => {
    const url = resolveShortLink('investors');
    expect(url).toContain('https://wa.me/972559966175?text=');
    expect(decodeURIComponent(url ?? '')).toContain(
      'היי, אשמח לקבל פרטים נוספים על תהליך ליווי משקיעים 1:1',
    );
  });

  it('returns null for unknown or malformed keys', () => {
    expect(resolveShortLink('nope')).toBeNull();
    expect(resolveShortLink('../etc')).toBeNull();
    expect(resolveShortLink('INVESTORS')).toBeNull();
    expect(resolveShortLink('')).toBeNull();
  });

  it('every configured destination is an absolute https URL', () => {
    for (const [key, url] of Object.entries(SHORT_LINKS)) {
      expect(url, key).toMatch(/^https:\/\//);
    }
  });
});
