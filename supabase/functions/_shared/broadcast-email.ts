// One place that turns an email broadcast into the message a recipient
// receives. Used by broadcast-dispatch (the real send) and by
// email-channel-status (the "send me a test" preview), so the preview is
// byte-for-byte what the 311 recipients get — subject, personalisation,
// sanitising, the RTL shell and the per-lead unsubscribe link.

import { renderEmailHtml, sanitizeEmailHtml, wrapEmailShell } from './email-html.ts';
import { unsubscribeHeaders, unsubscribeUrl } from './email-unsubscribe.ts';

/** The campaign body, before personalisation. */
export function broadcastBodyHtml(b: Record<string, unknown>): string {
  return (b.body_html as string | null) ??
    `<p>${String(b.body_snapshot ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br />')}</p>`;
}

export function broadcastSubject(b: Record<string, unknown>): string {
  return String(b.subject ?? b.name ?? 'עדכון מקרנף נדל"ן');
}

export interface RenderedBroadcastEmail {
  subject: string;
  html: string;
  headers: Record<string, string>;
  unsubscribeUrl: string | null;
}

/**
 * Personalise and wrap the campaign for one recipient. `leadId` null
 * renders without an unsubscribe link (the footer then offers the reply
 * route only) — used when a test goes to an address that is not a lead.
 */
export async function renderBroadcastEmail(
  b: Record<string, unknown>,
  recipient: { leadId: string | null; fullName: string | null },
  brandName: string,
): Promise<RenderedBroadcastEmail> {
  const fullName = recipient.fullName ?? '';
  const personalised = renderEmailHtml(broadcastBodyHtml(b), {
    first_name: fullName.split(' ')[0] ?? '',
    full_name: fullName,
  });
  const optOutUrl = recipient.leadId ? await unsubscribeUrl(recipient.leadId, b.id as string) : null;
  return {
    subject: broadcastSubject(b),
    html: wrapEmailShell(sanitizeEmailHtml(personalised), brandName, { unsubscribeUrl: optOutUrl }),
    headers: optOutUrl ? unsubscribeHeaders(optOutUrl) : {},
    unsubscribeUrl: optOutUrl,
  };
}
