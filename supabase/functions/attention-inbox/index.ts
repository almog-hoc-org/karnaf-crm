// Unified "needs attention" inbox: queue items + Mia-owed replies + overdue
// next-actions. Read-only; backed by the attention_inbox() RPC.

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

  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get('limit') ?? 200);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 200;

  const supabase = getServiceSupabase();
  const { data, error } = await supabase.rpc('attention_inbox', { p_limit: limit });
  if (error) return jsonResponse(req, { error: error.message }, 500);

  return jsonResponse(req, { ok: true, items: data ?? [] });
});
