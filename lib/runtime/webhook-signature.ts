// Webhook signature verification — the tested mirror of
// supabase/functions/_shared/webhook-signature.ts. Same function names and
// semantics as the shipping module (Request-based, constant-time compare),
// plus the value-based helpers older tests use. Keep in sync.

const encoder = new TextEncoder();

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function importHmacKey(secret: string, hash: 'SHA-256' | 'SHA-1' = 'SHA-256') {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash }, false, ['sign']);
}

/** Hex HMAC of an arbitrary string. */
export async function hmacHex(secret: string, body: string, hash: 'SHA-256' | 'SHA-1' = 'SHA-256'): Promise<string> {
  const key = await importHmacKey(secret, hash);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  let hex = '';
  for (const b of new Uint8Array(sig)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export async function computeMetaSignature(secret: string, body: string): Promise<string> {
  return `sha256=${await hmacHex(secret, body)}`;
}

export async function verifyMetaSignatureValue(
  headerValue: string | null,
  body: string,
  secret: string,
): Promise<boolean> {
  if (!secret || !headerValue || !headerValue.startsWith('sha256=')) return false;
  const expected = await hmacHex(secret, body);
  return safeEqual(headerValue.slice('sha256='.length).toLowerCase(), expected.toLowerCase());
}

/**
 * Verify a Meta WhatsApp Cloud API webhook payload.
 * Header: X-Hub-Signature-256 = "sha256=<hex>"
 */
export async function verifyMetaSignature(req: Request, body: string, appSecret: string): Promise<boolean> {
  if (!appSecret) return false;
  const header = req.headers.get('x-hub-signature-256') || '';
  if (!header.startsWith('sha256=')) return false;
  const expected = await hmacHex(appSecret, body, 'SHA-256');
  return safeEqual(header.slice('sha256='.length).toLowerCase(), expected.toLowerCase());
}

/**
 * Generic HMAC verification used by the payment provider and the intake hook.
 * Accepts a header containing the hex digest; tolerates an optional 'sha256='
 * prefix to support providers that follow the GitHub convention.
 */
export async function verifyHmacHeader(
  req: Request,
  body: string,
  secret: string,
  headerName: string | string[],
): Promise<boolean> {
  if (!secret) return false;
  const names = Array.isArray(headerName) ? headerName : [headerName];
  let raw = '';
  for (const name of names) {
    raw = (req.headers.get(name) || '').trim().toLowerCase();
    if (raw) break;
  }
  if (!raw) return false;
  const provided = raw.startsWith('sha256=') ? raw.slice('sha256='.length) : raw;
  const expected = (await hmacHex(secret, body, 'SHA-256')).toLowerCase();
  return safeEqual(provided, expected);
}

/**
 * Shared-secret bearer style: request includes `Authorization: Bearer <secret>`.
 * Used for cron-driven internal endpoints.
 */
export function verifyBearer(req: Request, expected: string): boolean {
  if (!expected) return false;
  const header = req.headers.get('authorization') || '';
  if (!header.toLowerCase().startsWith('bearer ')) return false;
  const provided = header.slice(7).trim();
  return safeEqual(provided, expected);
}

/** Bearer against any of several secrets (empty/missing ones never match). */
export function verifyAnyBearer(req: Request, expectedSecrets: Array<string | null | undefined>): boolean {
  const header = req.headers.get('authorization') || '';
  if (!header.toLowerCase().startsWith('bearer ')) return false;
  const provided = header.slice(7).trim();
  return expectedSecrets.some((secret) => !!secret && safeEqual(provided, secret));
}
