// Public landing page — Vercel Edge SSR.
//
// GET /api/lp/{slug} → reads the landing_pages row (anon key; RLS allows
// active rows only) and renders a self-contained RTL HTML page whose
// form posts to the website-leads-intake Supabase function with the
// page's slug. Unknown/inactive slug → 404. Same pattern as healthz.

export const config = { runtime: 'edge' };

import { renderLandingPage, type LandingPageConfig } from '../../lib/view-models/landing-page-html';

function readEnv(name: string): string | undefined {
  const v = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[name];
  return v && v.length > 0 ? v : undefined;
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.pathname.split('/').pop() ?? '';
  if (!/^[a-z0-9-]{2,60}$/.test(slug)) {
    return new Response('not found', { status: 404 });
  }

  const supabaseUrl = readEnv('VITE_SUPABASE_URL') ?? readEnv('SUPABASE_URL');
  const anon = readEnv('VITE_SUPABASE_ANON_KEY') ?? readEnv('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anon) return new Response('service unavailable', { status: 503 });

  const res = await fetch(
    `${supabaseUrl}/rest/v1/landing_pages?slug=eq.${encodeURIComponent(slug)}&active=eq.true` +
      '&select=slug,title,headline,subheadline,body_md,cta_label,form_config&limit=1',
    { headers: { apikey: anon, Authorization: `Bearer ${anon}` } },
  );
  if (!res.ok) return new Response('service unavailable', { status: 503 });
  const rows = (await res.json()) as LandingPageConfig[];
  const lp = rows[0];
  if (!lp) {
    return new Response(
      '<!doctype html><html dir="rtl" lang="he"><body style="font-family:Arial; text-align:center; padding:60px;"><h1>🦏</h1><p>הדף לא נמצא</p></body></html>',
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }

  const intakeUrl = `${supabaseUrl}/functions/v1/website-leads-intake`;
  return new Response(renderLandingPage(lp, intakeUrl), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
