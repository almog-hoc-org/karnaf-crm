// Tier 8.C — Rav Messer (Responder, responder.co.il) REST client.
//
// Single capability for now: add a subscriber to a mailing list. The
// CRM never sends marketing email itself — it hands the contact to a
// Rav Messer list and Rav Messer's automations run the sequence.
//
// API facts (dev.responder.co.il):
//  - POST https://api.responder.co.il/main/lists/{listId}/subscribers
//  - Body: application/x-www-form-urlencoded with a single key
//    `subscribers` = JSON string of an array of subscriber objects
//    ({NAME, EMAIL, PHONE, PHONE_IGNORE, NOTIFY, ...}).
//  - Auth: one `Authorization` header, comma-separated key=value pairs:
//    c_key, c_secret=md5(client_secret + nonce), u_key,
//    u_secret=md5(user_secret + nonce), nonce, timestamp.
//  - Response includes EMAILS_EXISTING — re-adding an existing address
//    is not an error, which makes the call naturally idempotent.
//
// Missing credentials → isConfigured() false and callers skip silently
// (same opt-in pattern as notify-telegram.ts).

// WebCrypto has no MD5 — Responder's auth scheme requires it, so pull
// the polyfilled digest from deno std.
import { crypto as stdCrypto } from 'https://deno.land/std@0.224.0/crypto/crypto.ts';
import { encodeHex } from 'https://deno.land/std@0.224.0/encoding/hex.ts';
import { env } from './env.ts';
import { log } from './logger.ts';

const API_BASE = 'https://api.responder.co.il/main';
const RETRIES = 2;
const BACKOFF_MS = 400;

export function isRavmesserConfigured(): boolean {
  return !!(env.ravmesserCKey() && env.ravmesserCSecret() && env.ravmesserUKey() && env.ravmesserUSecret());
}

async function md5Hex(input: string): Promise<string> {
  const digest = await stdCrypto.subtle.digest('MD5', new TextEncoder().encode(input));
  return encodeHex(digest);
}

// Exported for unit tests — nonce/timestamp injectable so the header is
// deterministic under test.
export async function buildResponderAuthHeader(
  nonce = crypto.randomUUID().replaceAll('-', ''),
  timestamp = Math.floor(Date.now() / 1000),
): Promise<string> {
  const cSecret = await md5Hex(env.ravmesserCSecret() + nonce);
  const uSecret = await md5Hex(env.ravmesserUSecret() + nonce);
  return [
    `c_key=${env.ravmesserCKey()}`,
    `c_secret=${cSecret}`,
    `u_key=${env.ravmesserUKey()}`,
    `u_secret=${uSecret}`,
    `nonce=${nonce}`,
    `timestamp=${timestamp}`,
  ].join(',');
}

export interface AddSubscriberResult {
  ok: boolean;
  created: boolean;
  existing: boolean;
  error?: string;
}

export async function addSubscriberToList(
  listId: string,
  sub: { email: string; name?: string | null; phone?: string | null },
): Promise<AddSubscriberResult> {
  if (!isRavmesserConfigured()) {
    return { ok: false, created: false, existing: false, error: 'ravmesser not configured' };
  }

  const subscriber: Record<string, unknown> = {
    EMAIL: sub.email,
    NOTIFY: 0,
    PHONE_IGNORE: true,
  };
  if (sub.name) subscriber.NAME = sub.name;
  if (sub.phone) subscriber.PHONE = sub.phone;

  const body = new URLSearchParams({ subscribers: JSON.stringify([subscriber]) });

  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/lists/${encodeURIComponent(listId)}/subscribers`, {
        method: 'POST',
        headers: {
          Authorization: await buildResponderAuthHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      const text = await res.text();
      if (res.status >= 500) throw new Error(`ravmesser_5xx:${res.status}:${text.slice(0, 120)}`);
      if (!res.ok) {
        return { ok: false, created: false, existing: false, error: `ravmesser ${res.status}: ${text.slice(0, 200)}` };
      }
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text);
      } catch {
        // Some endpoints wrap responses; treat unparseable 2xx as success.
      }
      const createdCount = Number(json.SUBSCRIBERS_CREATED ?? 0);
      const existing = Array.isArray(json.EMAILS_EXISTING)
        ? json.EMAILS_EXISTING.length > 0
        : Number(json.EMAILS_EXISTING ?? 0) > 0;
      const invalid = Array.isArray(json.EMAILS_INVALID) && json.EMAILS_INVALID.length > 0;
      if (invalid) {
        return { ok: false, created: false, existing: false, error: 'ravmesser: email invalid' };
      }
      return { ok: true, created: createdCount > 0, existing };
    } catch (err) {
      lastErr = err;
      if (attempt === RETRIES) break;
      const delay = BACKOFF_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
      log.warn('ravmesser_retry', { fn: 'ravmesser', attempt, delay, err: String(err) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return { ok: false, created: false, existing: false, error: String(lastErr) };
}
