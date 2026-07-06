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
}

// The columns segment filters can target. Guards against arbitrary
// column injection from a client-supplied segment object.
const ALLOWED_FIELDS = ['source', 'source_campaign', 'primary_track', 'product_interest'] as const;

// Apply the segment filter + the non-negotiable suppression guards
// (do_not_contact, removed_by_request) to a leads query builder.
export function applySegment<T>(query: T, segment: BroadcastSegment): T {
  // The Supabase query-builder type isn't chainable through a generic
  // here; a loose local type is the pragmatic choice.
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = query as any;
  q = q.eq('do_not_contact', false).eq('removed_by_request', false);
  for (const field of ALLOWED_FIELDS) {
    const value = segment?.[field];
    if (typeof value === 'string' && value.trim()) {
      q = q.eq(field, value.trim());
    }
  }
  return q as T;
}

// Count leads matching a segment.
export async function countSegment(
  supabase: SupabaseClient,
  segment: BroadcastSegment,
): Promise<number> {
  const base = supabase.from('leads').select('id', { count: 'exact', head: true });
  const { count, error } = await applySegment(base, segment);
  if (error) throw error;
  return count ?? 0;
}

// Fetch a page of leads matching a segment (id + display fields).
export async function fetchSegmentLeads(
  supabase: SupabaseClient,
  segment: BroadcastSegment,
  limit = 1000,
): Promise<Array<{ id: string; full_name: string | null; phone: string | null }>> {
  const base = supabase
    .from('leads')
    .select('id, full_name, phone')
    .order('created_at', { ascending: true })
    .limit(limit);
  const { data, error } = await applySegment(base, segment);
  if (error) throw error;
  return (data ?? []) as Array<{ id: string; full_name: string | null; phone: string | null }>;
}
