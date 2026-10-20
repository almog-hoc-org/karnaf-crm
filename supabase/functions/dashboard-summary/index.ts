import { jsonResponse, preflight } from '../_shared/cors.ts';
import { log } from '../_shared/logger.ts';
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

  // Single source of truth: the same attention_inbox RPC the inbox
  // renders. The old hand-rolled predicate silently disagreed with the
  // inbox (different exclusions, 2000-row cap), so the KPI and the
  // "לענות עכשיו" lane showed different numbers.
  const INBOX_LIMIT = 500;
  const { data: inboxRows, error: inboxErr } = await supabase.rpc('attention_inbox', { p_limit: INBOX_LIMIT });
  if (inboxErr) {
    // A failed RPC used to read as "0 waiting" — the most reassuring number
    // on the screen, for the least reassuring reason. Leave the KPI
    // undefined (the UI falls back to the summary's own count) and say so.
    log.warn('dashboard_summary_inbox_failed', { fn: 'dashboard-summary', err: inboxErr.message });
    const summary = { ...(data as Record<string, unknown>), awaitingReplyUnavailable: true };
    return jsonResponse(req, { ok: true, summary });
  }
  const rows = (inboxRows ?? []) as Array<{ kind: string }>;
  const awaitingReplyNow = rows
    .filter((r) => r.kind === 'awaiting_reply' || r.kind === 'mia_reply').length;
  // The RPC is capped, so this is a count of the first 500 attention rows,
  // not of everything. When the cap is hit the number is a floor and the UI
  // must say so — rendering a hard "500" for an unknown larger backlog is
  // the kind of quiet inaccuracy that makes an operator distrust the whole
  // dashboard once they notice it.
  const awaitingReplyCapped = rows.length >= INBOX_LIMIT;

  const summary = { ...(data as Record<string, unknown>), awaitingReplyNow, awaitingReplyCapped };
  return jsonResponse(req, { ok: true, summary });
});
