// Pure part of the per-lead unsubscribe link signing — the tested mirror of
// supabase/functions/_shared/email-unsubscribe.ts (which adds the env
// lookups and the URL). Keep in sync.
//
// The token is a truncated HMAC-SHA256 over `unsubscribe:<leadId>`: 32 hex
// chars (128 bit) is far beyond guessing and keeps the URL short enough for
// mail clients. Verification accepts a token signed with ANY of the
// configured secrets (dedicated secret first, then the legacy fallback), so
// introducing a dedicated secret does not break links already in inboxes.

const encoder = new TextEncoder();

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  let hex = '';
  for (const b of new Uint8Array(sig)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function tokenFor(secret: string, leadId: string): Promise<string> {
  const full = await hmacHex(secret, `unsubscribe:${leadId}`);
  return full.slice(0, 32);
}

/** Newest secret first; empties dropped; duplicates collapsed. */
export function signingSecrets(dedicated: string | undefined | null, legacy: string | undefined | null): string[] {
  return [...new Set([dedicated, legacy].filter((s): s is string => !!s))];
}

export async function verifyToken(secrets: string[], leadId: string, token: string): Promise<boolean> {
  if (!leadId || !token) return false;
  const provided = token.trim().toLowerCase();
  for (const secret of secrets) {
    if (safeEqual(provided, await tokenFor(secret, leadId))) return true;
  }
  return false;
}

/** RFC 8058 one-click headers. */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
