// Pure helpers for the Meta Conversions API (server-side events).
//
// Builds the /{pixel_id}/events payload: PII (email/phone) is SHA-256
// hashed per Meta's user_data spec; fbp/fbc ride in the clear. event_id
// should match the browser pixel's event id so Meta dedups the pair.
//
// IO lives in meta-capi-send.ts (Deno-only). This module is pure so it
// can be mirrored byte-identically to lib/runtime/meta-capi.ts and unit
// tested with vitest — crypto.subtle exists in both Deno and Node.

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Meta spec: trim + lowercase before hashing. */
export function normalizeEmailForCapi(raw: string | null | undefined): string | null {
  const email = (raw ?? '').trim().toLowerCase();
  return email.includes('@') ? email : null;
}

/**
 * Meta spec: digits only, with country code, no leading zeros/plus.
 * Israeli local numbers (05x-...) become 9725x...
 */
export function normalizePhoneForCapi(raw: string | null | undefined): string | null {
  let digits = (raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00972')) digits = digits.slice(2);
  else if (digits.startsWith('0') && digits.length >= 9) digits = `972${digits.slice(1)}`;
  return digits.length >= 11 ? digits : null;
}

export interface CapiUserInput {
  email?: string | null;
  phone?: string | null;
  fbp?: string | null;
  fbc?: string | null;
}

/** Hash em/ph, pass fbp/fbc through. Empty result = not enough signal. */
export async function buildUserData(input: CapiUserInput): Promise<Record<string, unknown>> {
  const userData: Record<string, unknown> = {};
  const email = normalizeEmailForCapi(input.email);
  if (email) userData.em = [await sha256Hex(email)];
  const phone = normalizePhoneForCapi(input.phone);
  if (phone) userData.ph = [await sha256Hex(phone)];
  if (input.fbp) userData.fbp = input.fbp;
  if (input.fbc) userData.fbc = input.fbc;
  return userData;
}

export interface CapiEventInput {
  eventName: 'Lead' | 'Purchase';
  eventId: string;
  eventTimeSec: number;
  sourceUrl?: string | null;
  userData: Record<string, unknown>;
  value?: number;
  currency?: string;
}

export function buildCapiEvent(opts: CapiEventInput): Record<string, unknown> {
  const event: Record<string, unknown> = {
    event_name: opts.eventName,
    event_time: Math.floor(opts.eventTimeSec),
    event_id: opts.eventId,
    action_source: 'website',
    user_data: opts.userData,
  };
  if (opts.sourceUrl) event.event_source_url = opts.sourceUrl;
  if (opts.value !== undefined || opts.currency) {
    event.custom_data = {
      ...(opts.value !== undefined ? { value: opts.value } : {}),
      currency: opts.currency ?? 'ILS',
    };
  }
  return event;
}
