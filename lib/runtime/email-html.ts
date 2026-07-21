// Email HTML helpers — pure logic. This file IS the tested mirror of
// _shared/email-html.ts; keep in sync.
//
// The composer produces "simple HTML" (paragraphs, links, images). We
// sanitize with a conservative allowlist — scripts, styles sheets,
// iframes, event handlers, and javascript: URLs never survive — and wrap
// the result in a single-column RTL shell with inline styles so it
// renders acceptably across email clients. Rav Messer appends its own
// unsubscribe footer at send time (legal opt-out lives on their side).

const ALLOWED_TAGS = new Set([
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'p', 'br', 'hr', 'div', 'span',
  'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'img', 'blockquote', 'table', 'tbody',
  'tr', 'td',
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'width', 'height', 'style']),
  '*': new Set(['style', 'dir', 'align']),
};

function sanitizeAttrValue(name: string, value: string): string | null {
  const trimmed = value.trim();
  if (name === 'href' || name === 'src') {
    if (!/^https?:\/\//i.test(trimmed)) return null;
    return trimmed;
  }
  if (name === 'style') {
    // Inline styles limited to benign presentational properties.
    const safe = trimmed
      .split(';')
      .map((rule) => rule.trim())
      .filter((rule) =>
        /^(color|background-color|font-size|font-weight|font-family|text-align|line-height|margin[a-z-]*|padding[a-z-]*|border[a-z-]*|width|max-width|height|display|border-radius)\s*:/i.test(rule) &&
        !/url\s*\(|expression|javascript/i.test(rule))
      .join('; ');
    return safe || null;
  }
  if (/javascript|data:/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * Allowlist sanitizer over an HTML string. Regex-based (no DOM in Deno
 * workers) — strips disallowed tags entirely (keeping their inner text
 * except for script/style/iframe whose CONTENT is also dropped) and
 * rebuilds allowed tags with only safe attributes.
 */
export function sanitizeEmailHtml(html: string): string {
  let out = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|form|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|iframe|object|embed|form)\b[^>]*\/?>(?:<\/\1>)?/gi, '');

  out = out.replace(/<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\s*(\/?)\s*>/g,
    (_m, closing: string, rawTag: string, rawAttrs: string, selfClose: string) => {
      const tag = rawTag.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return '';
      if (closing) return `</${tag}>`;

      const kept: string[] = [];
      const attrRe = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(rawAttrs)) !== null) {
        const name = (m[1] ?? '').toLowerCase();
        if (name.startsWith('on')) continue;
        const allowedForTag = ALLOWED_ATTRS[tag] ?? new Set<string>();
        if (!allowedForTag.has(name) && !(ALLOWED_ATTRS['*'] ?? new Set()).has(name)) continue;
        const value = sanitizeAttrValue(name, m[3] ?? m[4] ?? m[5] ?? '');
        if (value === null) continue;
        kept.push(`${name}="${value.replace(/"/g, '&quot;')}"`);
      }
      const attrs = kept.length ? ` ${kept.join(' ')}` : '';
      return `<${tag}${attrs}${selfClose ? ' /' : ''}>`;
    });

  return out.trim();
}

/** {{var}} interpolation, HTML-escaping the substituted values. */
export function renderEmailHtml(bodyHtml: string, vars: Record<string, string | null | undefined>): string {
  return bodyHtml.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, key: string) => {
    const value = vars[key];
    if (value === null || value === undefined || value === '') return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  });
}

/** Single-column RTL shell with inline styles (email-client-safe). */
export function wrapEmailShell(innerHtml: string, brandName = 'קרנף נדל"ן'): string {
  return [
    '<div dir="rtl" style="margin:0; padding:24px 12px; background-color:#f4f6f8; font-family:Arial,Helvetica,sans-serif;">',
    '<div style="max-width:600px; margin:0 auto; background-color:#ffffff; border-radius:12px; padding:28px 24px; text-align:right; color:#1e293b; font-size:16px; line-height:1.65;">',
    innerHtml,
    `<hr style="border:none; border-top:1px solid #e2e8f0; margin:28px 0 14px;" />`,
    `<p style="font-size:13px; color:#64748b; margin:0;">${brandName} 🦏</p>`,
    '</div>',
    '</div>',
  ].join('\n');
}
