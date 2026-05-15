// Admin-only webhook replay.
//
// Replays a row from webhook_inbox by POSTing the original body + safe
// headers back to the same upstream URL. The target function will re-run
// its full pipeline (signature verify, dedupe, etc.), producing a fresh
// webhook_inbox row linked to the original via `replayed_from`.
//
// Usage:
//   POST /functions/v1/webhook-replay
//   { "inboxId": "<uuid>" }                  // replay this specific row
//   { "filter": "failed_recent", "limit": 5 }  // replay up to N failures
//
// Auth: owner/admin only.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { env } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

interface ReplayInputSingle { inboxId: string; }
interface ReplayInputBatch { filter: 'failed_recent'; limit?: number; sourceOnly?: string; }

const SOURCE_TO_PATH: Record<string, string> = {
  'leads-intake': 'leads-intake',
  'whatsapp': 'whatsapp-webhook',
  'email': 'email-webhook',
  'payment': 'payment-webhook',
  'provider-status': 'provider-status-webhook',
};

async function replayOne(
  supabase: ReturnType<typeof getServiceSupabase>,
  inboxId: string,
  correlationId: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const { data: row, error } = await supabase
    .from('webhook_inbox')
    .select('id, source, headers_json, body, correlation_id')
    .eq('id', inboxId)
    .single();
  if (error || !row) return { ok: false, error: error?.message ?? 'not_found' };

  const path = SOURCE_TO_PATH[String(row.source)];
  if (!path) return { ok: false, error: `unsupported_source:${row.source}` };

  const url = `${env.supabaseUrl()}/functions/v1/${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-correlation-id': `replay:${correlationId}:${row.id}`,
    'x-replayed-from': String(row.id),
  };
  for (const [k, v] of Object.entries((row.headers_json ?? {}) as Record<string, string>)) {
    headers[k] = v;
  }

  try {
    const res = await fetch(url, { method: 'POST', headers, body: row.body });
    const text = await res.text();
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : text.slice(0, 200) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  let staff;
  try {
    staff = await requireStaff(req, { allow: ['owner', 'admin'] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const body = await req.json().catch(() => ({})) as Partial<ReplayInputSingle & ReplayInputBatch>;
  const supabase = getServiceSupabase();

  if (typeof body.inboxId === 'string' && body.inboxId.length > 0) {
    const r = await replayOne(supabase, body.inboxId, correlationId);
    log.info('webhook_replayed', { fn: 'webhook-replay', correlationId, by: staff.userId, inboxId: body.inboxId, ok: r.ok });
    // Order matters: spread first so `r`'s own ok flag doesn't shadow
    // the explicit one. Without this, TS flags the duplicate.
    return jsonResponse(req, { ...r });
  }

  if (body.filter === 'failed_recent') {
    const limit = Math.min(Math.max(1, Number(body.limit ?? 5)), 50);
    let q = supabase
      .from('webhook_inbox')
      .select('id, source')
      .or('processed_status.eq.server_error,processed_status.eq.replay_failed,processed_at.is.null')
      .gte('received_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString())
      .order('received_at', { ascending: false })
      .limit(limit);
    if (body.sourceOnly) q = q.eq('source', body.sourceOnly);
    const { data: rows, error } = await q;
    if (error) return jsonResponse(req, { error: error.message }, 500);
    const results: Array<{ inboxId: string; source: string; ok: boolean; error?: string }> = [];
    for (const row of rows ?? []) {
      const r = await replayOne(supabase, row.id, correlationId);
      results.push({ inboxId: row.id, source: row.source, ok: r.ok, error: r.error });
    }
    log.info('webhook_batch_replayed', { fn: 'webhook-replay', correlationId, by: staff.userId, count: results.length });
    return jsonResponse(req, { ok: true, results });
  }

  return jsonResponse(req, { error: 'Provide inboxId or filter' }, 400);
});
