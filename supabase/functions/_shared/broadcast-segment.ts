// Segment resolver for campaign broadcasts.
//
// A segment is a small selector over durable lead columns:
//   { source?, source_campaign?, primary_track?, product_interest? }
// Each field is a single value or an array (matched with IN). The
// resolver ALWAYS excludes do_not_contact + removed_by_request — a
// broadcast can never reach a suppressed lead, regardless of the
// selector. WhatsApp broadcasts additionally require a phone number.
//
// Kept as a shared module so the CRUD function (preview_count) and the
// dispatch worker (materialisation) resolve identical audiences.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface BroadcastSegment {
  source?: string | string[];
  source_campaign?: string | string[];
  primary_track?: string | string[];
  product_interest?: string | string[];
}

const SEGMENT_COLUMNS = ['source', 'source_campaign', 'primary_track', 'product_interest'] as const;

// Cap on how many leads a single broadcast can target. A safety rail so a
// too-broad segment (e.g. empty selector = everyone) can't materialise an
// unbounded number of recipient rows in one shot.
export const SEGMENT_HARD_CAP = 10_000;

// The PostgREST query-builder type is deeply generic and not worth
// reconstructing here; the filters below are all valid builder methods.
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Query = any;

function applySegment(query: Query, segment: BroadcastSegment, requirePhone: boolean): Query {
  let q = query.eq('do_not_contact', false).eq('removed_by_request', false);
  if (requirePhone) q = q.not('phone', 'is', null);
  for (const col of SEGMENT_COLUMNS) {
    const val = segment[col];
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      if (val.length === 0) continue;
      q = q.in(col, val);
    } else {
      q = q.eq(col, val);
    }
  }
  return q;
}

// Count reachable leads in a segment without materialising them.
export async function countSegment(
  supabase: SupabaseClient,
  segment: BroadcastSegment,
  requirePhone = true,
): Promise<number> {
  const base = supabase.from('leads').select('id', { count: 'exact', head: true });
  const { count, error } = await applySegment(base, segment, requirePhone);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

// Resolve the segment to concrete lead ids (capped).
export async function resolveSegmentLeadIds(
  supabase: SupabaseClient,
  segment: BroadcastSegment,
  requirePhone = true,
  limit = SEGMENT_HARD_CAP,
): Promise<string[]> {
  const base = supabase.from('leads').select('id').limit(limit);
  const { data, error } = await applySegment(base, segment, requirePhone);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: { id: string }) => r.id);
}
