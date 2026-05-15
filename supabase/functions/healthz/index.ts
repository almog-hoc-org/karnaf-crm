// Supabase Edge Function healthz — backend liveness + deep checks.
//
// GET /functions/v1/healthz            → liveness only.
// GET /functions/v1/healthz?deep=1     → +DB roundtrip + AI provider config +
//                                        cron last-run snapshot (job_runs).
//
// No auth required: payload contains no secrets. Use this from BetterUptime
// / Vercel monitor / external pinger. Health is 200 on success, 503 on
// any deep-check failure so uptime tooling can alert directly.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { env } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

interface Check {
  ok: boolean;
  latencyMs?: number;
  detail?: string;
}

async function checkDb(): Promise<Check> {
  const started = performance.now();
  try {
    const supabase = getServiceSupabase();
    const { error } = await supabase.from('crm_config').select('key').limit(1);
    return {
      ok: !error,
      latencyMs: Math.round(performance.now() - started),
      detail: error?.message,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      detail: String((err as Error)?.message ?? err).slice(0, 200),
    };
  }
}

async function checkLastNightlyRun(): Promise<Check> {
  // No-op if job_runs table is missing (migration 027 not applied yet).
  try {
    const supabase = getServiceSupabase();
    const { data, error } = await supabase
      .from('job_runs')
      .select('run_date, kind, status, completed_at')
      .order('started_at', { ascending: false })
      .limit(1);
    if (error) return { ok: true, detail: `job_runs_unavailable:${error.message}` };
    if (!data || data.length === 0) return { ok: true, detail: 'no_runs_yet' };
    const last = data[0];
    return { ok: last.status !== 'failed', detail: `${last.kind}@${last.run_date}:${last.status}` };
  } catch (err) {
    return { ok: true, detail: `exception:${String(err).slice(0, 80)}` };
  }
}

function checkAiProvider(): Check {
  // Configured-but-not-billed: we ONLY confirm an API key is set. We do not
  // make a real model call from healthz because that would burn $ per ping.
  return {
    ok: !!env.openaiApiKey(),
    detail: env.openaiApiKey() ? 'openai:configured' : 'openai:missing_key',
  };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const correlationId = correlationFromRequest(req);
  const url = new URL(req.url);
  const deep = url.searchParams.get('deep') === '1';

  const checked: Record<string, Check> = {};
  if (deep) {
    const [db, cron] = await Promise.all([checkDb(), checkLastNightlyRun()]);
    checked.db = db;
    checked.cron = cron;
    checked.ai = checkAiProvider();
  }

  const everythingOk = Object.values(checked).every((c) => c.ok);
  const payload = {
    ok: !deep || everythingOk,
    service: 'karnaf-crm-edge',
    deno: Deno.version,
    supabaseUrl: env.supabaseUrl(),
    checked,
    correlationId,
    generatedAt: new Date().toISOString(),
  };

  if (deep && !everythingOk) {
    log.warn('healthz_deep_failed', { fn: 'healthz', correlationId, checked });
  }
  return jsonResponse(req, payload, payload.ok ? 200 : 503);
});
