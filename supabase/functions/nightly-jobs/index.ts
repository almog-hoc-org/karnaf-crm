// Nightly housekeeping jobs invoked by pg_cron at 02:00 Asia/Jerusalem.
// Runs lead score decay, anonymises PII for removed leads beyond the
// retention window, and compacts integration_logs.
//
// Idempotency: each kind is guarded by claim_job_run(kind) (migration 027).
// If a kind already ran today the call is a no-op, so retries / clock
// skew / manual re-triggers cannot double-apply effects (e.g. score
// decaying twice in 24h).

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { env } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

type SupabaseClientLike = ReturnType<typeof getServiceSupabase>;

interface JobResult {
  ran: boolean;
  skipped?: 'already_ran_today';
  data?: unknown;
  error?: string;
}

// The `fn` is awaited inside so callers can pass either a plain Promise
// or a thenable (e.g. `supabase.rpc(...)` returns a PostgrestFilterBuilder
// that is thenable but not literally `Promise<T>`). PromiseLike covers both.
async function runGuardedJob(
  supabase: SupabaseClientLike,
  kind: string,
  fn: () => PromiseLike<{ data?: unknown; error?: { message: string } | null }>,
  correlationId: string,
): Promise<JobResult> {
  const { data: claimed, error: claimErr } = await supabase.rpc('claim_job_run', { p_kind: kind });
  if (claimErr) {
    log.error('claim_job_run_failed', { fn: 'nightly-jobs', correlationId, kind, err: claimErr.message });
    return { ran: false, error: `claim_failed:${claimErr.message}` };
  }
  if (claimed !== true) {
    log.info('job_already_ran_today', { fn: 'nightly-jobs', correlationId, kind });
    return { ran: false, skipped: 'already_ran_today' };
  }

  try {
    const r = await fn();
    if (r.error) {
      await supabase.rpc('finalize_job_run', { p_kind: kind, p_status: 'failed', p_error: r.error.message });
      log.error('job_failed', { fn: 'nightly-jobs', correlationId, kind, err: r.error.message });
      return { ran: true, error: r.error.message };
    }
    await supabase.rpc('finalize_job_run', { p_kind: kind, p_status: 'completed', p_error: null });
    return { ran: true, data: r.data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase.rpc('finalize_job_run', { p_kind: kind, p_status: 'failed', p_error: msg });
    log.error('job_exception', { fn: 'nightly-jobs', correlationId, kind, err: msg });
    return { ran: true, error: msg };
  }
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  const expected = env.slaWorkerSecret();
  if (!expected) {
    log.error('nightly_jobs_secret_missing', { fn: 'nightly-jobs', correlationId });
    return jsonResponse(req, { error: 'Worker secret not configured' }, 500);
  }
  if (!verifyBearer(req, expected)) return jsonResponse(req, { error: 'Unauthorized' }, 401);

  const supabase = getServiceSupabase();

  // Sequential rather than Promise.all so failures surface clearly and one
  // error doesn't mask another.
  const decay   = await runGuardedJob(supabase, 'apply_lead_score_decay',
    () => supabase.rpc('apply_lead_score_decay'), correlationId);
  const purge   = await runGuardedJob(supabase, 'purge_removed_pii',
    () => supabase.rpc('purge_removed_pii', { p_retention_days: 30 }), correlationId);
  const compact = await runGuardedJob(supabase, 'compact_integration_logs',
    () => supabase.rpc('compact_integration_logs', { p_keep_days: 14 }), correlationId);

  const summary = { decay, purge, compact };
  log.info('nightly_jobs_run', { fn: 'nightly-jobs', correlationId, summary });

  // Surface a non-2xx if any guarded job errored after claiming. Skipped
  // (already-ran-today) is NOT an error — that's the idempotency working.
  const anyErrored = [decay, purge, compact].some((r) => r.error);
  return jsonResponse(req, { ok: !anyErrored, correlationId, summary }, anyErrored ? 500 : 200);
});
