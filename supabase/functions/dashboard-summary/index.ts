import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'GET') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  try { await requireStaff(req); } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const supabase = getServiceSupabase();
  const { data, error } = await supabase.rpc('dashboard_summary');
  if (error) return jsonResponse(req, { error: error.message }, 500);

  // True "customer wrote and got no reply yet" counter — inbound newer
  // than outbound, any ownership, no 8h floor. The RPC's unansweredNow
  // is status-based and diverges from what operators see in the inbox;
  // computed here because PostgREST cannot compare two columns.
  const { data: candidates } = await supabase
    .from('leads')
    .select('last_inbound_at, last_outbound_at')
    .not('last_inbound_at', 'is', null)
    .not('lead_status', 'in', '("won","lost","do_not_contact","removed_by_request")')
    .eq('do_not_contact', false)
    .eq('removed_by_request', false)
    .limit(2000);
  const awaitingReplyNow = (candidates ?? []).filter((l) => {
    const inbound = l.last_inbound_at ? Date.parse(l.last_inbound_at as string) : NaN;
    const outbound = l.last_outbound_at ? Date.parse(l.last_outbound_at as string) : NaN;
    return Number.isFinite(inbound) && (!Number.isFinite(outbound) || outbound < inbound);
  }).length;

  const summary = { ...(data as Record<string, unknown>), awaitingReplyNow };
  return jsonResponse(req, { ok: true, summary });
});
