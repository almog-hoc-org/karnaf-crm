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

  try { await requireStaff(req); } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const heat = url.searchParams.get('heat');
  const ownershipMode = url.searchParams.get('ownershipMode');
  const search = url.searchParams.get('search');
  const searchIn = (url.searchParams.get('searchIn') ?? 'lead') as 'lead' | 'messages';
  const createdFrom = url.searchParams.get('createdFrom');
  const createdTo = url.searchParams.get('createdTo');
  const inboundFrom = url.searchParams.get('inboundFrom');
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));

  const isValidDate = (s: string | null): boolean => !!s && Number.isFinite(Date.parse(s));

  const supabase = getServiceSupabase();
  let query = supabase
    .from('leads')
    .select('id, full_name, phone, email, source, lead_status, lead_heat, ownership_mode, lead_score, payment_status, last_message_at, last_inbound_at, last_outbound_at, do_not_contact, removed_by_request, updated_at, created_at', { count: 'exact' })
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('lead_status', status);
  if (heat) query = query.eq('lead_heat', heat);
  if (ownershipMode) query = query.eq('ownership_mode', ownershipMode);
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

  return jsonResponse(req, { ok: true, leads: data ?? [], total: count ?? null, limit, offset });
});
