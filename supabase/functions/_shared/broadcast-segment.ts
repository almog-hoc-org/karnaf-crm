// Shared segment resolver for the broadcast module.
//
// A broadcast segment is a small filter object. This turns it into a
// leads query, always excluding contactable-suppressed leads. Used by
// both the broadcasts edge fn (preview_count) and the broadcast-dispatch
// worker (materialise recipients).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
// filter. Exported for the unit-test mirror.
export function splitSegmentValue(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export interface SegmentChannelOptions {
  channel?: 'whatsapp' | 'email';
  // Israeli spam law: marketing email needs prior opt-in. When true
  // (the default for email via crm_config email_channel.requireConsent),
  // only consent_email = true leads qualify.
  requireEmailConsent?: boolean;
}

// Apply the segment filter + the non-negotiable suppression guards
// (do_not_contact, removed_by_request) to a leads query builder.
export function applySegment<T>(query: T, segment: BroadcastSegment, opts: SegmentChannelOptions = {}): T {
  // The Supabase query-builder type isn't chainable through a generic
  // here; a loose local type is the pragmatic choice.
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = query as any;
  q = q.eq('do_not_contact', false).eq('removed_by_request', false);
  if (opts.channel === 'email') {
    q = q.not('email', 'is', null);
    if (opts.requireEmailConsent !== false) q = q.eq('consent_email', true);
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

// Count leads matching a segment.
export async function countSegment(
  supabase: SupabaseClient,
  segment: BroadcastSegment,
  opts: SegmentChannelOptions = {},
): Promise<number> {
  const base = supabase.from('leads').select('id', { count: 'exact', head: true });
  const { count, error } = await applySegment(base, segment, opts);
  if (error) throw error;
  return count ?? 0;
}

// Fetch a page of leads matching a segment (id + display fields).
export async function fetchSegmentLeads(
  supabase: SupabaseClient,
  segment: BroadcastSegment,
  limit = 1000,
  opts: SegmentChannelOptions = {},
): Promise<Array<{ id: string; full_name: string | null; phone: string | null; email: string | null }>> {
  const base = supabase
    .from('leads')
    .select('id, full_name, phone, email')
    .order('created_at', { ascending: true })
    .limit(limit);
  const { data, error } = await applySegment(base, segment, opts);
  if (error) throw error;
  return (data ?? []) as Array<{ id: string; full_name: string | null; phone: string | null; email: string | null }>;
}
