// Make.com → CRM bridge (signing proxy).
//
// Why this exists: the Make scenarios (IG comments, FB lead ads, FB
// messenger, generic intake) historically POSTed leads to an OLD
// Supabase project with a simple `x-api-key`. The live CRM's
// `leads-intake` requires an HMAC signature that Make can't easily
// produce without the secret. This thin proxy accepts the simple
// `x-api-key` (MAKE_INTAKE_KEY), signs the body with the real
// INTAKE_WEBHOOK_SECRET, and forwards to `leads-intake` so the lead
// flows through the full live pipeline (classify + SLA queue + engine).
//
// Additive only — does not touch any existing function.

import { jsonResponse, preflight } from '../_shared/cors.ts';

const INTAKE_KEY = Deno.env.get('MAKE_INTAKE_KEY') ?? '';
const SIGN_SECRET = Deno.env.get('INTAKE_WEBHOOK_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const provided = (req.headers.get('x-api-key') ?? '').trim();
  if (!INTAKE_KEY || !timingSafeEqual(provided, INTAKE_KEY)) {
    return jsonResponse(req, { error: 'Unauthorized' }, 401);
  }
  if (!SIGN_SECRET) return jsonResponse(req, { error: 'Bridge not configured' }, 503);

  const body = await req.text();
  const signature = await hmacHex(SIGN_SECRET, body);

  const res = await fetch(`${SUPABASE_URL}/functions/v1/leads-intake`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-karnaf-signature': signature,
      // Gateway apikey so the call reaches the (verify_jwt=false) function.
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
    },
    body,
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
});
