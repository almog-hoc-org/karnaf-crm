// Universal no-HMAC lead bridge → live CRM.
//
// Why: external systems that can't compute the CRM's HMAC signature
// (Make.com HTTP modules, Rav Messer/Responder webhooks, the website's
// own backend) need a simple way in. This bridge authenticates with a
// shared key (MAKE_INTAKE_KEY) via either the `x-api-key` header OR a
// `?token=` query param (Responder webhooks can't set custom headers),
// normalizes common field-name variants to the CRM's shape, HMAC-signs
// with INTAKE_WEBHOOK_SECRET, and forwards to the live `leads-intake`
// pipeline (classify + SLA queue + engine emit).
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

// Pull the first present value across a set of candidate field names
// (covers English caps, lowercase, and Hebrew labels that Rav Messer /
// website forms emit).
function pick(obj: Record<string, unknown>, names: string[]): string | undefined {
  for (const n of names) {
    const v = obj[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

// Normalize an arbitrary inbound payload to the CRM intake shape.
// Pass-through anything already named correctly; map common variants.
function normalize(raw: Record<string, unknown>, defaultSource: string): Record<string, unknown> {
  // Rav Messer/Responder splits the name into `first`/`last`; many form
  // tools use `name`/`NAME`/`full_name`. Try the whole-name fields first,
  // then fall back to joining first+last.
  let full_name = pick(raw, ['full_name', 'name', 'NAME', 'fullname', 'שם', 'שם מלא']);
  if (!full_name) {
    const first = pick(raw, ['first', 'first_name', 'firstname', 'fname']);
    const last = pick(raw, ['last', 'last_name', 'lastname', 'lname']);
    const joined = [first, last].filter(Boolean).join(' ').trim();
    if (joined) full_name = joined;
  }
  const phone = pick(raw, ['phone', 'PHONE', 'mobile', 'טלפון', 'נייד', 'cellphone']);
  const email = pick(raw, ['email', 'EMAIL', 'mail', 'אימייל', 'דוא"ל']);
  const source = pick(raw, ['source', 'SOURCE']) ?? defaultSource;
  const out: Record<string, unknown> = { ...raw };
  if (full_name) out.full_name = full_name;
  if (phone) out.phone = phone;
  if (email) out.email = email;
  out.source = source;
  const notes = pick(raw, ['notes', 'message', 'הערות', 'list_name', 'LIST_NAME']);
  if (notes && !out.notes) out.notes = notes;
  return out;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const url = new URL(req.url);
  const provided = (req.headers.get('x-api-key') || url.searchParams.get('token') || '').trim();
  if (!INTAKE_KEY || !timingSafeEqual(provided, INTAKE_KEY)) {
    return jsonResponse(req, { error: 'Unauthorized' }, 401);
  }
  if (!SIGN_SECRET) return jsonResponse(req, { error: 'Bridge not configured' }, 503);

  // Parse JSON or form-encoded (Rav Messer webhooks can send either).
  const rawText = await req.text();
  let raw: Record<string, unknown>;
  const ct = req.headers.get('content-type') ?? '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    raw = Object.fromEntries(new URLSearchParams(rawText));
  } else {
    try { raw = JSON.parse(rawText || '{}'); } catch { return jsonResponse(req, { error: 'Invalid body' }, 400); }
  }

  // `source` can also ride on the query string (?source=responder_form).
  const defaultSource = url.searchParams.get('source') || 'unknown';
  const normalized = normalize(raw, defaultSource);
  const body = JSON.stringify(normalized);
  const signature = await hmacHex(SIGN_SECRET, body);

  const res = await fetch(`${SUPABASE_URL}/functions/v1/leads-intake`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-karnaf-signature': signature,
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
