import { describe, expect, it } from 'vitest';
import {
  EMAIL_OPT_OUT_LINE,
  EMAIL_OPT_OUT_LINK_TEXT,
  renderEmailHtml,
  sanitizeEmailHtml,
  wrapEmailShell,
} from './email-html';

describe('sanitizeEmailHtml', () => {
  it('strips script tags including their content', () => {
    const out = sanitizeEmailHtml('<p>שלום</p><script>alert(1)</script><p>עולם</p>');
    expect(out).toContain('<p>שלום</p>');
    expect(out).toContain('<p>עולם</p>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert');
  });

  it('drops on* event handlers and javascript: URLs', () => {
    const out = sanitizeEmailHtml('<a href="javascript:evil()" onclick="x()">קישור</a><a href="https://karnafnadlan.com">טוב</a>');
    expect(out).not.toContain('javascript');
    expect(out).not.toContain('onclick');
    expect(out).toContain('href="https://karnafnadlan.com"');
  });

  it('keeps images with https sources and drops data: URIs', () => {
    const out = sanitizeEmailHtml('<img src="https://cdn.example/pic.png" alt="a"><img src="data:text/html;evil" alt="b">');
    expect(out).toContain('src="https://cdn.example/pic.png"');
    expect(out).not.toContain('data:');
  });

  it('removes disallowed tags but keeps text', () => {
    const out = sanitizeEmailHtml('<video controls>клип</video><p>טקסט</p>');
    expect(out).not.toContain('<video');
    expect(out).toContain('<p>טקסט</p>');
  });

  it('filters style rules to a safe subset', () => {
    const out = sanitizeEmailHtml('<p style="color: red; position: fixed; background-image: url(x)">t</p>');
    expect(out).toContain('color: red');
    expect(out).not.toContain('position');
    expect(out).not.toContain('url(');
  });
});

describe('renderEmailHtml', () => {
  it('substitutes variables and escapes injected HTML', () => {
    const out = renderEmailHtml('<p>היי {{first_name}}</p>', { first_name: '<b>מוגי</b>' });
    expect(out).toBe('<p>היי &lt;b&gt;מוגי&lt;/b&gt;</p>');
  });

  it('drops missing variables silently', () => {
    expect(renderEmailHtml('שלום {{missing}}!', {})).toBe('שלום !');
  });
});

describe('wrapEmailShell', () => {
  it('always tells the reader how to unsubscribe (חוק הספאם)', () => {
    const out = wrapEmailShell('<p>תוכן</p>');
    expect(out).toContain(EMAIL_OPT_OUT_LINE);
    expect(out).toContain('הסר');
  });

  it('links to the per-lead unsubscribe route when one is given', () => {
    const url = 'https://xyz.supabase.co/functions/v1/email-unsubscribe?l=abc&t=deadbeef';
    const out = wrapEmailShell('<p>תוכן</p>', 'קרנף נדל"ן', { unsubscribeUrl: url });
    expect(out).toContain(EMAIL_OPT_OUT_LINK_TEXT);
    // The & in the query string must be escaped inside the href attribute.
    expect(out).toContain('href="https://xyz.supabase.co/functions/v1/email-unsubscribe?l=abc&amp;t=deadbeef"');
    expect(out).not.toContain(EMAIL_OPT_OUT_LINE);
  });

  it('falls back to the reply route when no link is available', () => {
    const out = wrapEmailShell('<p>תוכן</p>', 'קרנף נדל"ן', {});
    expect(out).toContain(EMAIL_OPT_OUT_LINE);
    expect(out).not.toContain('<a href');
  });

  it('produces an RTL single-column shell containing the body', () => {
    const out = wrapEmailShell('<p>תוכן</p>');
    expect(out).toContain('dir="rtl"');
    expect(out).toContain('<p>תוכן</p>');
    expect(out).toContain('max-width:600px');
  });
});
