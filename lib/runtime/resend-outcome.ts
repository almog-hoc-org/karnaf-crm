// How to react to a Resend API response — pure logic, mirrored in
// supabase/functions/_shared/resend.ts (which adds the fetch). Keep in sync.
//
// The distinction matters for a broadcast: a RETRYABLE failure (rate limit,
// Resend outage) must leave the recipient 'pending' so the next tick picks
// them up, while a FATAL one (address rejected, domain not verified) must
// mark the recipient 'failed' — retrying it forever would stall the campaign.

export type ResendOutcome = 'ok' | 'retryable' | 'fatal';

/**
 * Classify an HTTP status from api.resend.com.
 *   429            → rate limited (2 req/s on the default plan)
 *   5xx            → their side; try again next tick
 *   408 / network  → treat as transient (pass status 0 for a thrown fetch)
 *   other 4xx      → our payload is wrong for this recipient
 */
export function classifyResendStatus(status: number): ResendOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 0 || status === 408 || status === 429 || status >= 500) return 'retryable';
  return 'fatal';
}

/** True when the whole broadcast should stop this tick rather than burn recipients. */
export function shouldPauseSending(outcome: ResendOutcome): boolean {
  return outcome === 'retryable';
}

/** Local-part+domain split used by the domain-verification preflight. */
export function emailDomain(address: string): string {
  const trimmed = address.trim();
  // "קרנף נדל\"ן <hi@example.com>" → example.com
  const angled = /<([^>]+)>/.exec(trimmed);
  const bare = (angled?.[1] ?? trimmed).trim();
  const at = bare.lastIndexOf('@');
  if (at < 0) return '';
  return bare.slice(at + 1).toLowerCase();
}

/** Free-mail domains Resend will never let us send FROM. */
const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'live.com',
  'yahoo.com', 'walla.com', 'walla.co.il', 'icloud.com', 'me.com',
]);

export function isPublicMailDomain(domain: string): boolean {
  return PUBLIC_MAIL_DOMAINS.has(domain.toLowerCase());
}
