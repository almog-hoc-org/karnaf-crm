// Opt-out / re-subscribe detection and the outbound opt-out footer —
// pure logic. This file IS the tested mirror of _shared/opt-out.ts (the
// Deno side adds the database effects); keep the two in sync.
//
// Israeli spam law (חוק הספאם): every marketing message must let the
// recipient remove themselves, and a removal request must stop further
// mailings. Detection is deliberately conservative: a SHORT message that
// contains a stop keyword ("הסר", "STOP"), or equals one exactly. A long
// message that merely mentions removal ("אני לא מעוניין בדירה בחיפה אלא
// בתל אביב") goes on to the AI, whose opt_out playbook handles nuance.

export const DEFAULT_OPT_OUT_KEYWORDS = [
  'הסר', 'הסירו', 'הסירו אותי', 'תסיר', 'תסירו', 'להסיר',
  'תוריד', 'תורידו', 'להוריד אותי', 'תפסיק', 'תפסיקו',
  'לא מעוניין', 'לא מעוניינת', 'אל תפנו', 'אל תשלחו',
  'stop', 'unsubscribe', 'remove me', 'opt out',
];

export const DEFAULT_RESUBSCRIBE_KEYWORDS = ['חזור', 'הרשם', 'תרשמו אותי', 'resubscribe', 'start'];

export const DEFAULT_OPT_OUT_FOOTER = 'להסרה מרשימת התפוצה השיבו "הסר"';

export const DEFAULT_OPT_OUT_CONFIRMATION =
  'הוסרת מרשימת התפוצה שלנו ולא נשלח לך עוד הודעות שיווקיות. אם תרצה לחזור, כתוב "חזור".';

export const DEFAULT_RESUBSCRIBE_CONFIRMATION = 'חזרת לרשימת התפוצה שלנו. תודה!';

// Messages longer than this are never treated as a bare command.
const MAX_COMMAND_WORDS = 6;

export interface MessagingConfig {
  optOutKeywords: string[];
  resubscribeKeywords: string[];
  optOutFooter: string;
  optOutConfirmation: string;
  resubscribeConfirmation: string;
}

export const DEFAULT_MESSAGING: MessagingConfig = {
  optOutKeywords: DEFAULT_OPT_OUT_KEYWORDS,
  resubscribeKeywords: DEFAULT_RESUBSCRIBE_KEYWORDS,
  optOutFooter: DEFAULT_OPT_OUT_FOOTER,
  optOutConfirmation: DEFAULT_OPT_OUT_CONFIRMATION,
  resubscribeConfirmation: DEFAULT_RESUBSCRIBE_CONFIRMATION,
};

/** Fill a partial crm_config `messaging` value with defaults; tolerate junk. */
export function resolveMessaging(raw: unknown): MessagingConfig {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const strList = (v: unknown, fallback: string[]) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length > 0 ? v as string[] : fallback;
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v : fallback);
  return {
    optOutKeywords: strList(obj.optOutKeywords, DEFAULT_MESSAGING.optOutKeywords),
    resubscribeKeywords: strList(obj.resubscribeKeywords, DEFAULT_MESSAGING.resubscribeKeywords),
    optOutFooter: str(obj.optOutFooter, DEFAULT_MESSAGING.optOutFooter),
    optOutConfirmation: str(obj.optOutConfirmation, DEFAULT_MESSAGING.optOutConfirmation),
    resubscribeConfirmation: str(obj.resubscribeConfirmation, DEFAULT_MESSAGING.resubscribeConfirmation),
  };
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    // Quotes, punctuation and emoji around a command ("הסר!", «STOP», 🛑 הסר)
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesKeyword(text: string, keywords: string[]): boolean {
  const norm = normalise(text);
  if (!norm) return false;
  const words = norm.split(' ');
  if (words.length > MAX_COMMAND_WORDS) return false;
  for (const raw of keywords) {
    const kw = normalise(raw);
    if (!kw) continue;
    if (norm === kw) return true;
    // Whole-word containment: "הסר אותי מהרשימה" yes; "הסרטון נשלח" no.
    if ((' ' + norm + ' ').includes(' ' + kw + ' ')) return true;
  }
  return false;
}

/** True when the inbound text is a removal request. */
export function detectOptOut(text: string | null | undefined, keywords = DEFAULT_OPT_OUT_KEYWORDS): boolean {
  if (!text) return false;
  return matchesKeyword(text, keywords);
}

/** True when the inbound text asks to be put back on the list. */
export function detectResubscribe(text: string | null | undefined, keywords = DEFAULT_RESUBSCRIBE_KEYWORDS): boolean {
  if (!text) return false;
  return matchesKeyword(text, keywords);
}

/**
 * Append the opt-out line to an outgoing marketing text. Idempotent: a
 * body that already carries the footer (or already tells the reader how
 * to unsubscribe) is returned unchanged. `oneLine` is for template
 * parameters, which Meta rejects when they contain newlines.
 */
export function appendOptOutFooter(
  text: string,
  footer = DEFAULT_OPT_OUT_FOOTER,
  opts: { oneLine?: boolean } = {},
): string {
  const body = text.trimEnd();
  if (!footer.trim()) return body;
  if (normalise(body).includes(normalise(footer))) return body;
  return opts.oneLine ? `${body} · ${footer}` : `${body}\n\n${footer}`;
}
