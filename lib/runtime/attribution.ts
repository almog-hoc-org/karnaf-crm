// Pure helpers for first-touch campaign attribution on leads.
//
// The website sends utm_* / landing_page / referrer (and optionally
// fbclid / fbp / fbc / event_id / page_url) with every form submission.
// The dedicated lead columns are FIRST-TOUCH: written once when empty,
// never overwritten. Every later submission is recorded in the
// last_touch jsonb column instead.
//
// Byte-identical mirror: lib/runtime/attribution.ts (tested with vitest).

export interface Attribution {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  landing_page: string | null;
  referrer: string | null;
  fbclid: string | null;
  fbp: string | null;
  fbc: string | null;
  /** Browser-side event id for CAPI dedup — not persisted as a column. */
  event_id: string | null;
  /** Page the form was submitted from — used as CAPI event_source_url. */
  page_url: string | null;
}

/** Attribution keys that map 1:1 to leads columns (first-touch). */
export const FIRST_TOUCH_COLUMNS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'landing_page',
  'referrer',
  'fbclid',
  'fbp',
  'fbc',
] as const;

const MAX_ATTR_LEN = 200;

function cleanString(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim().slice(0, MAX_ATTR_LEN);
  return trimmed || null;
}

/** Extract and sanitize attribution fields from a raw intake payload. */
export function extractAttribution(payload: Record<string, unknown>): Attribution {
  return {
    utm_source: cleanString(payload.utm_source),
    utm_medium: cleanString(payload.utm_medium),
    utm_campaign: cleanString(payload.utm_campaign),
    utm_content: cleanString(payload.utm_content),
    utm_term: cleanString(payload.utm_term),
    landing_page: cleanString(payload.landing_page) ?? cleanString(payload.page_path),
    referrer: cleanString(payload.referrer),
    fbclid: cleanString(payload.fbclid),
    fbp: cleanString(payload.fbp),
    fbc: cleanString(payload.fbc),
    event_id: cleanString(payload.event_id),
    page_url: cleanString(payload.page_url),
  };
}

/**
 * Build the fbc cookie format from a raw fbclid when the browser did not
 * send an fbc value: fb.1.<creation time ms>.<fbclid>.
 */
export function deriveFbc(fbclid: string | null, nowMs: number): string | null {
  if (!fbclid) return null;
  return `fb.1.${Math.floor(nowMs)}.${fbclid}`;
}

function isEmpty(val: unknown): boolean {
  return val === null || val === undefined || val === '';
}

/**
 * Compute the leads.update() patch for one submission: fill first-touch
 * columns only where the lead has no value yet, stamp first_touch_at on
 * the first submission that carries any attribution, and always record
 * the submission's attribution in last_touch.
 */
export function buildFirstTouchUpdates(
  lead: Record<string, unknown>,
  attrs: Attribution,
  nowIso: string,
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  let hasAttribution = false;

  for (const key of FIRST_TOUCH_COLUMNS) {
    const value = attrs[key];
    if (value === null) continue;
    hasAttribution = true;
    if (isEmpty(lead[key])) updates[key] = value;
  }

  if (hasAttribution && isEmpty(lead.first_touch_at)) {
    updates.first_touch_at = nowIso;
  }

  const lastTouch: Record<string, unknown> = { touched_at: nowIso };
  for (const key of FIRST_TOUCH_COLUMNS) {
    const value = attrs[key];
    if (value !== null) lastTouch[key] = value;
  }
  if (attrs.page_url) lastTouch.page_url = attrs.page_url;
  updates.last_touch = lastTouch;

  return updates;
}
