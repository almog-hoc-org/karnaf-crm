// Constant-time helper used by both the Deno webhook handlers and the
// Vitest suite (mirrored in supabase/functions/_shared/webhook-signature.ts).

const encoder = new TextEncoder();

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
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
