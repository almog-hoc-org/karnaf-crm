// Per-lead unsubscribe links for marketing email.
//
// Rav Messer appended its own unsubscribe footer; Resend does not, so the
// CRM must carry the link itself to satisfy חוק הספאם (and to keep Gmail
// happy, which wants List-Unsubscribe on bulk mail). The link is signed:
// the lead id alone must not be enough to unsubscribe somebody else, and
// the endpoint is public (verify_jwt = false) because a mail client follows
// it without any session.
//
// The pure token logic is mirrored in lib/runtime/email-unsubscribe.ts
// (tested); keep the two in sync.

import { env, optional } from './env.ts';
import { safeEqual } from './env.ts';
import { hmacHex } from './webhook-signature.ts';

/** Truncated HMAC-SHA256 over the lead id — 32 hex chars (128 bit) is far
 *  beyond guessing and keeps the URL short enough for email clients. */
export async function tokenFor(secret: string, leadId: string): Promise<string> {
  const full = await hmacHex(secret, `unsubscribe:${leadId}`);
  return full.slice(0, 32);
}

/**
 * Every secret a link may have been signed with, newest first. Until an
 * EMAIL_UNSUBSCRIBE_SECRET is configured, links are signed with the
 * service-role key; once it is configured, new links use it — and the
 * links already sitting in people's inboxes (signed with the key) keep
 * working, because verification tries both. Rotating the service-role key
 * therefore only breaks old links if no dedicated secret was ever set.
 */
function signingSecrets(): string[] {
  const dedicated = optional('EMAIL_UNSUBSCRIBE_SECRET');
  const serviceKey = optional('SUPABASE_SERVICE_ROLE_KEY');
  return [...new Set([dedicated, serviceKey].filter((s): s is string => !!s))];
}

export async function unsubscribeToken(leadId: string): Promise<string> {
  return await tokenFor(env.emailUnsubscribeSecret(), leadId);
}

export async function verifyUnsubscribeToken(leadId: string, token: string): Promise<boolean> {
  if (!leadId || !token) return false;
  const provided = token.trim().toLowerCase();
  for (const secret of signingSecrets()) {
    if (safeEqual(provided, await tokenFor(secret, leadId))) return true;
  }
  return false;
}

/** Absolute URL of the public one-click endpoint for this lead. */
export async function unsubscribeUrl(leadId: string, broadcastId?: string | null): Promise<string> {
  const token = await unsubscribeToken(leadId);
  const params = new URLSearchParams({ l: leadId, t: token });
  if (broadcastId) params.set('b', broadcastId);
  return `${env.supabaseUrl()}/functions/v1/email-unsubscribe?${params.toString()}`;
}

/** RFC 8058 one-click headers: Gmail/Outlook render a native "Unsubscribe"
 *  button and POST to the URL, never showing the reader a confirmation. */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
