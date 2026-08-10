// Branded short links served by /api/go/{key} (Vercel Edge, 302).
//
// Used to wrap long/ugly destination URLs (wa.me deep links with
// prefilled text) in a clean address the bot can drop into a WhatsApp
// message. Keys are code-reviewed on purpose: this is a public open
// redirect surface, so only explicit allowlisted destinations exist —
// never a pass-through of a query param.

export const SHORT_LINKS: Record<string, string> = {
  // WhatsApp of the investors division, with a prefilled Hebrew message:
  // "היי, אשמח לקבל פרטים נוספים על תהליך ליווי משקיעים 1:1"
  investors:
    'https://wa.me/972559966175?text=' +
    encodeURIComponent('היי, אשמח לקבל פרטים נוספים על תהליך ליווי משקיעים 1:1'),
};

export function resolveShortLink(key: string): string | null {
  if (!/^[a-z0-9-]{1,40}$/.test(key)) return null;
  return SHORT_LINKS[key] ?? null;
}
