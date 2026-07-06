import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';

// PostgREST `or` interprets several characters syntactically (`,` separates
// filters, `()` group, `*` is the ilike wildcard, `%` is its alias, `:` is a
// type cast prefix, and `\` is an escape). Anything that could break out of
// the ilike value into a sibling filter has to go before the search string
// reaches the query builder.
function escapeForOr(input: string): string {
  return input
    .replace(/[(),%*:\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'GET') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  try {
    await requireStaff(req);
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const heat = url.searchParams.get('heat');
  const ownershipMode = url.searchParams.get('ownershipMode');
  const source = url.searchParams.get('source');
  const search = url.searchParams.get('search');
  const searchIn = (url.searchParams.get('searchIn') ?? 'lead') as 'lead' | 'messages';
  const createdFrom = url.searchParams.get('createdFrom');
  const createdTo = url.searchParams.get('createdTo');
  const inboundFrom = url.searchParams.get('inboundFrom');
  // Tier 6.A — product group filter. Single param that matches either
  // primary_track OR product_interest because the two columns evolved
  // historically and a lead may have one but not the other (e.g.
  // primary_track='investor_mentorship' with product_interest=null on
  // a freshly-classified lead). Coarse-grained groups instead of raw
  // enum values to keep the UI scannable for a non-CRM user.
  const productGroup = url.searchParams.get('productGroup');
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));

  const isValidDate = (s: string | null): boolean => !!s && Number.isFinite(Date.parse(s));

  const supabase = getServiceSupabase();
  let query = supabase
    .from('leads')
    .select(
      'id, full_name, phone, email, source, source_campaign, lead_status, lead_heat, ownership_mode, lead_score, payment_status, last_message_at, last_inbound_at, last_outbound_at, do_not_contact, removed_by_request, updated_at, created_at, inquiry_type, product_interest, interest_topic, intake_segment, suggested_next_action, program_members(lead_id)',
      { count: 'exact' },
    )
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('lead_status', status);
  if (heat) query = query.eq('lead_heat', heat);
  // member=true → only program members (inner-join semantics on the
  // embedded program_members select).
  if (url.searchParams.get('member') === 'true') {
    query = query.not('program_members', 'is', null);
  }
  if (ownershipMode) query = query.eq('ownership_mode', ownershipMode);
  if (source) {
    // A single label can cover several source slugs (e.g. אתר →
    // website,landing_page,services_page). Comma-separated → IN filter.
    const slugs = source.slice(0, 200).split(',').map((s) => s.trim()).filter(Boolean);
    query = slugs.length > 1 ? query.in('source', slugs) : query.eq('source', slugs[0] ?? source);
  }
  // Map coarse product groups → real enum values across both columns.
  // The mapping is in code (not data) so a typo in the UI param
  // produces a deterministic empty result, not a malformed query.
  if (productGroup) {
    const productMap: Record<string, { tracks: string[]; interests: string[] }> = {
      program: { tracks: ['program'], interests: ['digital_program'] },
      investor: { tracks: ['investor_mentorship'], interests: ['investor_mentorship', 'mentorship'] },
      presale: { tracks: ['presale'], interests: ['contractor_group_purchase'] },
      consultation: { tracks: [], interests: ['personal_consultation', 'financing_guidance', 'student_tools', 'unknown'] },
    };
    const m = productMap[productGroup];
    if (m) {
      const parts: string[] = [];
      if (m.tracks.length) parts.push(`primary_track.in.(${m.tracks.join(',')})`);
      if (m.interests.length) parts.push(`product_interest.in.(${m.interests.join(',')})`);
      if (parts.length) query = query.or(parts.join(','));
    } else {
      // Unknown group key → return empty rather than ignore. Loud is
      // better than silently broad.
      return jsonResponse(req, { ok: true, leads: [], total: 0, limit, offset });
    }
  }
  if (isValidDate(createdFrom)) query = query.gte('created_at', createdFrom as string);
  if (isValidDate(createdTo)) query = query.lte('created_at', createdTo as string);
  if (isValidDate(inboundFrom)) query = query.gte('last_inbound_at', inboundFrom as string);
  if (search) {
    const safe = escapeForOr(search);
    if (safe) {
      if (searchIn === 'messages') {
        const { data: hits } = await supabase
          .from('messages')
          .select('lead_id')
          .ilike('content_text', `%${safe}%`)
          .not('lead_id', 'is', null)
          .limit(500);
        const leadIds = Array.from(new Set((hits ?? []).map((r) => r.lead_id).filter(Boolean) as string[]));
        if (leadIds.length === 0) {
          return jsonResponse(req, { ok: true, leads: [], total: 0, limit, offset });
        }
        query = query.in('id', leadIds);
      } else {
        query = query.or(`full_name.ilike.%${safe}%,phone.ilike.%${safe}%,email.ilike.%${safe}%`);
      }
    }
  }

  const { data, error, count } = await query;
  if (error) return jsonResponse(req, { error: error.message }, 500);

  // Flatten the embedded join into a boolean the UI can render directly.
  const leads = (data ?? []).map((row) => {
    const { program_members: pm, ...rest } = row as Record<string, unknown> & { program_members?: unknown[] };
    return { ...rest, is_program_member: Array.isArray(pm) ? pm.length > 0 : Boolean(pm) };
  });

  return jsonResponse(req, { ok: true, leads, total: count ?? null, limit, offset });
});
