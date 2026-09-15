// Public one-click unsubscribe landing for marketing email.
//
// GET  → a reader clicked the footer link: revoke email consent, show a
//        Hebrew confirmation page.
// POST → RFC 8058 one-click: Gmail/Outlook's native "Unsubscribe" button
//        posts here with no body and expects a 200; the reader never sees
//        a page.
//
// No JWT (config.toml verify_jwt = false) — a mail client carries no
// session. The lead id alone is not enough: the link is signed with an
// HMAC (see _shared/email-unsubscribe.ts), so guessing an id changes
// nothing. Revoking is scope 'email' only — someone who clicks a link in a
// mailing did not ask to stop receiving WhatsApp replies.

import { getServiceSupabase } from '../_shared/supabase.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { verifyUnsubscribeToken } from '../_shared/email-unsubscribe.ts';
import { applyOptOut } from '../_shared/opt-out.ts';

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // A one-click POST comes from the mail provider, not a browser tab.
      'X-Robots-Tag': 'noindex',
    },
  });
}

function page(title: string, lines: string[], tone: 'ok' | 'error' = 'ok'): string {
  const accent = tone === 'ok' ? '#0f766e' : '#b91c1c';
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
</head>
<body style="margin:0; padding:32px 16px; background-color:#f4f6f8; font-family:Arial,Helvetica,sans-serif; color:#1e293b;">
  <div style="max-width:520px; margin:0 auto; background-color:#ffffff; border-radius:14px; padding:32px 24px; text-align:center;">
    <div style="font-size:40px; line-height:1;">${tone === 'ok' ? '✅' : '⚠️'}</div>
    <h1 style="font-size:22px; margin:16px 0 8px; color:${accent};">${title}</h1>
    ${lines.map((l) => `<p style="font-size:15px; line-height:1.7; color:#475569; margin:8px 0;">${l}</p>`).join('\n    ')}
    <p style="font-size:13px; color:#94a3b8; margin-top:24px;">קרנף נדל"ן 🦏</p>
  </div>
</body>
</html>`;
}

Deno.serve(async (req) => {
  const correlationId = correlationFromRequest(req);
  if (req.method !== 'GET' && req.method !== 'POST') {
    return htmlResponse(page('פעולה לא נתמכת', ['הקישור נפתח בשיטה שאינה נתמכת.'], 'error'), 405);
  }

  const url = new URL(req.url);
  const leadId = (url.searchParams.get('l') ?? '').trim();
  const token = (url.searchParams.get('t') ?? '').trim();
  const broadcastId = (url.searchParams.get('b') ?? '').trim() || null;

  const valid = await verifyUnsubscribeToken(leadId, token);
  if (!valid) {
    log.warn('email_unsubscribe_bad_token', { fn: 'email-unsubscribe', correlationId, leadId });
    return htmlResponse(page('הקישור אינו תקין', [
      'ייתכן שהקישור נחתך בהעתקה.',
      'אפשר פשוט להשיב למייל עם המילה "הסר" ונסיר אתכם מיד.',
    ], 'error'), 400);
  }

  const supabase = getServiceSupabase();
  const { data: lead } = await supabase
    .from('leads').select('id, consent_email').eq('id', leadId).maybeSingle();
  if (!lead) {
    return htmlResponse(page('לא מצאנו את הרישום', [
      'ייתכן שכבר הוסרתם מרשימת התפוצה.',
    ], 'error'), 404);
  }

  // Idempotent: a second click (or the provider's POST after the reader's
  // GET) must answer 200, not an error.
  if (lead.consent_email !== false) {
    try {
      await applyOptOut(supabase, {
        leadId,
        channel: 'email',
        basis: 'provider_unsubscribe',
        scope: 'email',
        text: broadcastId ? `unsubscribe link (broadcast ${broadcastId})` : 'unsubscribe link',
        correlationId,
      });
      log.info('email_unsubscribe_applied', { fn: 'email-unsubscribe', correlationId, leadId, broadcastId });
    } catch (err) {
      log.error('email_unsubscribe_failed', {
        fn: 'email-unsubscribe', correlationId, leadId, err: String(err),
      });
      return htmlResponse(page('משהו השתבש', [
        'לא הצלחנו לעדכן את ההסרה כרגע.',
        'השיבו למייל עם המילה "הסר" ונטפל בזה ידנית.',
      ], 'error'), 500);
    }
  }

  if (req.method === 'POST') {
    return new Response('unsubscribed', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  return htmlResponse(page('הוסרתם מרשימת התפוצה', [
    'לא נשלח לכם יותר דיוור שיווקי במייל.',
    'אם זו הייתה טעות — השיבו לאחד המיילים שלנו עם המילה "חזור" ונחזיר אתכם לרשימה.',
  ]));
});
