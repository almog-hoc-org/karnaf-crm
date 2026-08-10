// Branded short-link redirect — Vercel Edge.
//
// GET /api/go/{key} → 302 to the allowlisted destination from
// lib/view-models/short-links (e.g. /api/go/investors → the investors
// division wa.me deep link). Unknown key → RTL 404. Never an open
// redirect: destinations are compiled into the bundle.

export const config = { runtime: 'edge' };

import { resolveShortLink } from '../../lib/view-models/short-links';

export default function handler(req: Request): Response {
  const url = new URL(req.url);
  const key = (url.pathname.split('/').pop() ?? '').toLowerCase();
  const destination = resolveShortLink(key);

  if (!destination) {
    return new Response(
      '<!doctype html><html dir="rtl" lang="he"><meta charset="utf-8"><title>לא נמצא</title>' +
        '<body style="font-family:sans-serif;text-align:center;padding:4rem">' +
        '<h1>הקישור לא נמצא 🦏</h1><p>ייתכן שהקישור שגוי או שהוסר.</p></body></html>',
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: destination,
      'Cache-Control': 'public, max-age=300',
    },
  });
}
