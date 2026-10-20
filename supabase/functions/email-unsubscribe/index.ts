// Public unsubscribe landing for marketing email.
//
// GET  → a reader clicked the footer link: show a Hebrew page with ONE
//        button ("הסירו אותי"). Nothing changes on GET. Mail security
//        gateways (Outlook Safe Links, corporate scanners) and link
//        previews follow every URL in a message with a GET; while GET
//        revoked consent, those scanners unsubscribed readers who never
//        clicked anything.
// POST → the button, or RFC 8058 one-click (Gmail/Outlook's native
//        "Unsubscribe" posts here with `List-Unsubscribe=One-Click` and
//        expects a 200 with no page). Revokes email consent.
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(
  title: string,
  lines: string[],
  tone: 'ok' | 'error' | 'ask' = 'ok',
  form?: { label: string },
): string {
  const accent = tone === 'error' ? '#b91c1c' : tone === 'ask' ? '#1d4ed8' : '#0f766e';
  const icon = tone === 'error' ? '⚠️' : tone === 'ask' ? '✉️' : '✅';
  // No `action`: the browser posts back to the page's own URL, query string
  // (l, t, b) included. The function never sees the public path — the
  // gateway strips /functions/v1 — so an action built from req.url pointed
  // at a path that 404s, and the button unsubscribed nobody.
  const button = form
    ? `<form method="post" style="margin:20px 0 0;">
      <button type="submit" style="background:${accent}; color:#fff; border:0; border-radius:10px; padding:12px 28px; font-size:16px; cursor:pointer;">${escapeHtml(form.label)}</button>
    </form>`
    : '';
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0; padding:32px 16px; background-color:#f4f6f8; font-family:Arial,Helvetica,sans-serif; color:#1e293b;">
  <div style="max-width:520px; margin:0 auto; background-color:#ffffff; border-radius:14px; padding:32px 24px; text-align:center;">
    <div style="font-size:40px; line-height:1;">${icon}</div>
    <h1 style="font-size:22px; margin:16px 0 8px; color:${accent};">${escapeHtml(title)}</h1>
    ${lines.map((l) => `<p style="font-size:15px; line-height:1.7; color:#475569; margin:8px 0;">${l}</p>`).join('\n    ')}
    ${button}
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

  if (req.method === 'GET') {
    if (lead.consent_email === false) {
      return htmlResponse(page('כבר הוסרתם מרשימת התפוצה', [
        'לא נשלח לכם דיוור שיווקי במייל.',
        'אם זו הייתה טעות — השיבו לאחד המיילים שלנו עם המילה "חזור" ונחזיר אתכם לרשימה.',
      ]));
    }
    // The page itself changes nothing; the button posts back to this URL.
    return htmlResponse(page('להסרה מרשימת התפוצה', [
      'לחיצה על הכפתור תסיר אתכם מדיוור שיווקי במייל של קרנף נדל"ן.',
      'תשובות להודעות שלכם ושירות ללקוחות קיימים ימשיכו כרגיל.',
    ], 'ask', { label: 'הסירו אותי מרשימת התפוצה' }));
  }

  // POST — the button, or a provider's one-click. Idempotent: a second
  // click (or the provider's POST after the reader's) must answer 200.
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

  // RFC 8058 one-click: the mail provider posts a form body and wants a
  // bare 200. A browser (the button) gets the confirmation page.
  const contentType = req.headers.get('content-type') ?? '';
  const body = contentType.includes('application/x-www-form-urlencoded') ? await req.text().catch(() => '') : '';
  const oneClick = body.includes('List-Unsubscribe=One-Click');
  const fromBrowser = (req.headers.get('accept') ?? '').includes('text/html') && !oneClick;
  if (!fromBrowser) {
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
