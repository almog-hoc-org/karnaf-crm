// Webhook signature verification helpers. Constant-time comparison is used
// to defeat timing attacks. Each helper accepts the raw body string so the
// caller is responsible for reading the body once and reusing it.

import { safeEqual } from './env.ts';

const encoder = new TextEncoder();

async function importHmacKey(secret: string, hash: 'SHA-256' | 'SHA-1' = 'SHA-256') {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash },
    false,
    ['sign'],
  );
}

async function hmacHex(secret: string, body: string, hash: 'SHA-256' | 'SHA-1' = 'SHA-256'): Promise<string> {
  const key = await importHmacKey(secret, hash);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
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
  headerName: string,
): Promise<boolean> {
  if (!secret) return false;
  const raw = (req.headers.get(headerName) || '').trim().toLowerCase();
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
