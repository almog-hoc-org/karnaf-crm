// Broadcast segment → leads query filter: the tested mirror of
// supabase/functions/_shared/broadcast-segment.ts (which adds the Supabase
// client helpers countSegment / fetchSegmentLeads). Keep the pure part in
// sync — applySegment, CLOSED_STATUSES, ALLOWED_FIELDS, splitSegmentValue.

export interface BroadcastSegment {
  source?: string | null;
  source_campaign?: string | null;
  primary_track?: string | null;
  product_interest?: string | null;
  // First-touch ad attribution (columns added in migration 110).
  utm_campaign?: string | null;
  utm_source?: string | null;
  // Any-overlap match against leads.tags (GIN-indexed text[]).
  tags?: string[] | null;
}

// The columns segment filters can target. Guards against arbitrary
// column injection from a client-supplied segment object.
const ALLOWED_FIELDS = ['source', 'source_campaign', 'primary_track', 'product_interest', 'utm_campaign', 'utm_source'] as const;

// A segment value may carry several slugs comma-joined — one Hebrew UI
// label fronts multiple raw source slugs (e.g. "אתר" → website,
// landing_page, services_page), same convention as the leads-list source
// filter.
export function splitSegmentValue(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export interface SegmentChannelOptions {
  channel?: 'whatsapp' | 'email';
  // Israeli spam law: marketing email needs prior opt-in. When true
  // (the default for email via crm_config email_channel.requireConsent),
  // only consent_email = true leads qualify; when false, NULL qualifies
  // too — an explicit false never does.
  requireEmailConsent?: boolean;
  // Injected by tests; the snooze cut-off.
  now?: Date;
}

// Statuses that mean the relationship is over (or the row is a dedupe
// artifact), plus the two "stop" statuses whose boolean flags may be stale:
// transition_lead_status only moves lead_status, so a lead parked as
// do_not_contact / removed_by_request by status alone used to pass the
// boolean checks below. A broadcast is marketing to an open pipeline; none
// of these leads are in it. Note this exclusion lives HERE and not in
// contact-guard: lifecycle sends (student check-ins) legitimately target
// won leads.
export const CLOSED_STATUSES = ['won', 'lost', 'duplicate', 'do_not_contact', 'removed_by_request'] as const;

// Apply the segment filter + the non-negotiable suppression guards to a
// leads query builder. The suppressions mirror contact-guard (kind:
// 'proactive') expressed as SQL, so a preview count and the actual send
// agree on who is reachable — snoozed and no-proactive-contact leads used
// to be counted in the preview and then messaged for real.
export function applySegment<T>(query: T, segment: BroadcastSegment, opts: SegmentChannelOptions = {}): T {
  // The Supabase query-builder type isn't chainable through a generic
  // here; a loose local type is the pragmatic choice.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = query as any;
  q = q.eq('do_not_contact', false).eq('removed_by_request', false);
  q = q.eq('no_proactive_contact', false);
  q = q.or(`snoozed_until.is.null,snoozed_until.lte.${(opts.now ?? new Date()).toISOString()}`);
  q = q.not('lead_status', 'in', `("${CLOSED_STATUSES.join('","')}")`);
  if (opts.channel === 'email') {
    q = q.not('email', 'is', null);
    // חוק הספאם: an explicit refusal (consent_email = false — unsubscribe
    // link, "הסר" reply) is excluded whatever the setting says. The
    // requireEmailConsent setting only decides whether NULL ("never asked")
    // qualifies; before this, unticking it re-admitted everyone who had
    // asked to be removed.
    q = q.not('consent_email', 'is', false);
    if (opts.requireEmailConsent !== false) q = q.eq('consent_email', true);
  } else {
    // WhatsApp is the default channel; a lead with no phone is counted in
    // the preview and then skipped at send time — the numbers never matched.
    q = q.not('phone', 'is', null);
    // An explicit WhatsApp opt-out (the lead page / bulk "הסכמת דיוור")
    // excludes the lead. NULL means "never recorded" and stays reachable,
    // same rule as contact-guard. `IS NOT FALSE` keeps NULL and true, and
    // avoids a second .or() next to the snooze one.
    q = q.not('consent_whatsapp', 'is', false);
  }
  for (const field of ALLOWED_FIELDS) {
    const value = segment?.[field];
    if (typeof value === 'string' && value.trim()) {
      const slugs = splitSegmentValue(value);
      if (slugs.length > 1) q = q.in(field, slugs);
      else if (slugs.length === 1) q = q.eq(field, slugs[0]);
    }
  }
  // Tags are handled explicitly (array overlap), never via ALLOWED_FIELDS.
  const tags = Array.isArray(segment?.tags)
    ? segment.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
    : [];
  if (tags.length > 0) q = q.overlaps('tags', tags);
  return q as T;
}
