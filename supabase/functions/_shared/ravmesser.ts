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

// ── Campaign primitives (email broadcasts) ──────────────────────────
// Responder sends campaigns to a LIST, not to individual recipients:
//   1. create a dedicated list per broadcast,
//   2. push the segment's subscribers into it (addSubscriberToList),
//   3. create a message (subject + HTML) and send it to the list.
// Opens/clicks/unsubscribes are tracked on the Rav Messer side, which
// also appends the legally-required opt-out footer.

async function ravPost(path: string, form: Record<string, string>): Promise<{ ok: boolean; json: Record<string, unknown>; error?: string }> {
  if (!isRavmesserConfigured()) return { ok: false, json: {}, error: 'ravmesser not configured' };
  const body = new URLSearchParams(form);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: {
          Authorization: await buildResponderAuthHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      const text = await res.text();
      if (res.status >= 500) throw new Error(`ravmesser_5xx:${res.status}:${text.slice(0, 120)}`);
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      if (!res.ok) return { ok: false, json, error: `ravmesser ${res.status}: ${text.slice(0, 200)}` };
      return { ok: true, json };
    } catch (err) {
      lastErr = err;
      if (attempt === RETRIES) break;
      const delay = BACKOFF_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
      log.warn('ravmesser_retry', { fn: 'ravmesser', path, attempt, delay, err: String(err) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return { ok: false, json: {}, error: String(lastErr) };
}

function firstNumericId(json: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = json[key];
    if (typeof v === 'number' || (typeof v === 'string' && v)) return String(v);
  }
  return null;
}

export async function createRavmesserList(input: {
  name: string;
  senderName: string;
  senderEmail: string;
  description?: string;
}): Promise<{ ok: boolean; listId?: string; error?: string }> {
  const { ok, json, error } = await ravPost('/lists', {
    info: JSON.stringify({
      NAME: input.name,
      DESCRIPTION: input.description ?? 'נוצרה אוטומטית מ-Karnaf CRM עבור תפוצת מייל',
      SENDER_NAME: input.senderName,
      SENDER_EMAIL: input.senderEmail,
    }),
  });
  if (!ok) return { ok: false, error };
  const listId = firstNumericId(json, ['LIST_ID', 'ID', 'list_id', 'id']);
  if (!listId) return { ok: false, error: `ravmesser: no list id in response ${JSON.stringify(json).slice(0, 200)}` };
  return { ok: true, listId };
}

export async function createRavmesserMessage(input: {
  listId: string;
  subject: string;
  html: string;
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const { ok, json, error } = await ravPost(`/lists/${encodeURIComponent(input.listId)}/messages`, {
    info: JSON.stringify({
      TYPE: '1',
      BODY_TYPE: '0',
      SUBJECT: input.subject,
      BODY: input.html,
      LANGUAGE: 'he',
    }),
  });
  if (!ok) return { ok: false, error };
  const messageId = firstNumericId(json, ['MESSAGE_ID', 'ID', 'message_id', 'id']);
  if (!messageId) return { ok: false, error: `ravmesser: no message id in response ${JSON.stringify(json).slice(0, 200)}` };
  return { ok: true, messageId };
}

export async function sendRavmesserMessage(listId: string, messageId: string): Promise<{ ok: boolean; error?: string }> {
  const { ok, json, error } = await ravPost(
    `/lists/${encodeURIComponent(listId)}/messages/${encodeURIComponent(messageId)}`,
    {},
  );
  if (!ok) return { ok: false, error };
  if (json.MESSAGE_SENT === true || json.MESSAGE_SENT === 'true') return { ok: true };
  return { ok: false, error: `ravmesser: unexpected send response ${JSON.stringify(json).slice(0, 200)}` };
}
