// Mirror of lib/runtime/email-reply.ts (where it is unit-tested) — keep in sync.
//
// A reply to a campaign carries the whole campaign quoted underneath it, so
// "הסר" arrives as one word on top of 300 words of our own text. Opt-out
// detection only fires on short messages, so it never saw the request until
// the quoted part is cut away.

// Lines that start the quoted original. Checked per line, first hit wins.
const QUOTE_START: RegExp[] = [
  /^on .{3,200}wrote:?\s*$/i,                       // Gmail EN: "On Tue, 29 Sep 2026 at 18:01, X <x@y> wrote:"
  /^בתאריך .{3,200}(מאת|כתב|כתבה|כתב\/ה|נכתב).*:\s*$/,  // Gmail HE: "בתאריך יום ג׳, 29 בספט׳ 2026 ב-18:01 מאת X <x@y>:"
  /<[^<>\s]+@[^<>\s]+>.{0,40}:\s*$/,                // any "… Name <addr@host> …:" attribution line
  /^-{2,}\s*(original message|הודעה מקורית|forwarded message|הודעה שהועברה)\s*-{2,}/i,
  /^_{8,}\s*$/,                                     // Outlook separator
  /^(from|מאת)\s*:\s*.+/i,                          // Outlook header block
  /^sent from my (iphone|ipad|android|samsung)/i,
  /^נשלח מ(ה)?[-־]?\s?(אייפון|iphone|ipad|אנדרואיד|סמסונג|android|samsung)/i,  // "נשלח מה-iPhone שלי"
];

/** The reply text above the quoted original, without signature or blank lines. */
export function extractReplyText(text: string | null | undefined): string {
  if (!text) return '';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (const raw of lines) {
    // Gmail wraps Hebrew attribution lines in bidi control marks.
    const line = raw.replace(/[‎‏‪-‮⁦-⁩]/g, '').trim();
    if (line.startsWith('>')) break;                // quoted block
    if (QUOTE_START.some((re) => re.test(line))) break;
    if (line === '--' || line === '-- ') break;      // signature delimiter
    kept.push(raw.trimEnd());
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
