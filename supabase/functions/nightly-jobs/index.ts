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

async function runGuardedJob(
  supabase: SupabaseClientLike,
  kind: string,
  fn: () => Promise<{ data?: unknown; error?: { message: string } | null }>,
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

  // Run each job under its own idempotency guard. Sequential rather than
  // Promise.all so a failure surfaces clearly and one error doesn't mask
  // another.
  const decay   = await runGuardedJob(supabase, 'apply_lead_score_decay',
    () => supabase.rpc('apply_lead_score_decay'), correlationId);
  const purge   = await runGuardedJob(supabase, 'purge_removed_pii',
    () => supabase.rpc('purge_removed_pii', { p_retention_days: 30 }), correlationId);
  const compact = await runGuardedJob(supabase, 'compact_integration_logs',
    () => supabase.rpc('compact_integration_logs', { p_keep_days: 14 }), correlationId);
  const reweight = await runGuardedJob(supabase, 'auto_reweight_prompt_variants',
    async () => ({ data: await autoReweightPromptVariants(supabase, correlationId) }),
    correlationId);

  const summary = { decay, purge, compact, reweight };
  log.info('nightly_jobs_run', { fn: 'nightly-jobs', correlationId, summary });

  // Surface a non-2xx if any guarded job errored after claiming. Skipped
  // (already-ran-today) is NOT an error — that's the idempotency working.
  const anyErrored = [decay, purge, compact, reweight].some((r) => r.error);
  return jsonResponse(req, { ok: !anyErrored, correlationId, summary }, anyErrored ? 500 : 200);
});

// Auto-reweight prompt variants based on operator ratings.
//
// Rules — kept conservative on purpose so we don't collapse onto a single
// variant prematurely:
//   * Need at least 20 ratings on a variant before any change.
//   * Trigger only when mean rating drops below -0.2 (skewed thumbs-down).
//   * Halve the weight, but clamp at a 0.1 floor so we keep some traffic
//     for recovery (and so the analytics view always has data to show).
//   * Only touch variants that are currently active and have weight >= 1.
//   * Skip silently if the v_prompt_variant_review_stats view doesn't exist
//     yet (i.e. migration 022 not applied) — no-op rather than error.
async function autoReweightPromptVariants(supabase: SupabaseClientLike, correlationId: string): Promise<number> {
  let adjusted = 0;
  try {
    const { data: stats, error } = await supabase
      .from('v_prompt_variant_review_stats')
      .select('prompt_version, playbook_name, ratings_total, mean_rating');
    if (error) {
      log.warn('variant_stats_unavailable', { fn: 'nightly-jobs', correlationId, err: error.message });
      return 0;
    }

    for (const row of stats ?? []) {
      const total = Number(row.ratings_total ?? 0);
      const mean = Number(row.mean_rating ?? 0);
      if (total < 20 || mean >= -0.2) continue;

      // Find the active variant row matching (playbook, version) and halve its weight.
      const { data: variant, error: vErr } = await supabase
        .from('prompt_variants')
        .select('id, weight, is_active')
        .eq('playbook_name', row.playbook_name)
        .eq('version', row.prompt_version)
        .eq('is_active', true)
        .maybeSingle();
      if (vErr || !variant) continue;

      const current = Number(variant.weight ?? 0);
      if (!Number.isFinite(current) || current < 1) continue;
      const next = Math.max(0.1, current / 2);
      if (Math.abs(next - current) < 0.05) continue; // already at floor

      const { error: updErr } = await supabase
        .from('prompt_variants')
        .update({ weight: next })
        .eq('id', variant.id);
      if (updErr) {
        log.warn('variant_reweight_update_failed', {
          fn: 'nightly-jobs', correlationId, variantId: variant.id, err: updErr.message,
        });
        continue;
      }
      adjusted++;
      log.info('variant_auto_reweighted', {
        fn: 'nightly-jobs', correlationId,
        variantId: variant.id, playbook: row.playbook_name, version: row.prompt_version,
        from: current, to: next, ratingsTotal: total, meanRating: mean,
      });
    }
  } catch (err) {
    log.warn('variant_reweight_exception', { fn: 'nightly-jobs', correlationId, err: String(err) });
  }
  return adjusted;
}
