// Supabase Edge Function healthz — backend liveness + deep checks.
//
// GET /functions/v1/healthz            → liveness only.
// GET /functions/v1/healthz?deep=1     → +DB roundtrip + AI provider config +
//                                        cron last-run snapshot (job_runs).
//
// No auth required for the status code: uptime monitors (BetterUptime,
// Vercel) only need the 200/503. The deep checks run service-role queries,
// so unauthenticated callers are rate-limited per IP and get booleans only;
// the detail strings (which name the AI provider and the last cron job)
// are returned when the caller presents the worker secret as a bearer —
// the same trust level as the cron-driven workers.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { env } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { checkRateLimit, clientIdentifier } from '../_shared/rate-limit.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';

interface Check {
  ok: boolean;
  latencyMs?: number;
  detail?: string;
}

async function checkDb(): Promise<Check> {
  const started = performance.now();
  try {
    const supabase = getServiceSupabase();
    const { error } = await supabase.from('crm_config').select('config_key').limit(1);
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

// A nightly job that stopped firing used to report ok forever: only the
// last row's status was read, never its age. 26h tolerates a slow night.
const NIGHTLY_MAX_AGE_MS = 26 * 60 * 60_000;

async function checkLastNightlyRun(): Promise<Check> {
  // No-op if job_runs table is missing (migration 027 not applied yet).
  try {
    const supabase = getServiceSupabase();
    const { data, error } = await supabase
      .from('job_runs')
      .select('run_date, kind, status, started_at, completed_at')
      .order('started_at', { ascending: false })
      .limit(1);
    if (error) return { ok: true, detail: `job_runs_unavailable:${error.message}` };
    const last = data?.[0];
    if (!last) return { ok: true, detail: 'no_runs_yet' };
    const ageMs = last.started_at ? Date.now() - Date.parse(last.started_at as string) : 0;
    const stale = ageMs > NIGHTLY_MAX_AGE_MS;
    return {
      ok: last.status !== 'failed' && !stale,
      detail: `${last.kind}@${last.run_date}:${last.status}${stale ? ':stale' : ''}`,
    };
  } catch (err) {
    return { ok: true, detail: `exception:${String(err).slice(0, 80)}` };
  }
}

function checkAiProvider(): Check {
  // Configured-but-not-billed: we ONLY confirm the selected provider has an
  // API key. We do not make a real model call from healthz because that would
  // burn $ per ping.
  const provider = env.aiProvider();
  if (provider === 'gemini' || provider === 'google') {
    return {
      ok: !!env.geminiApiKey(),
      detail: env.geminiApiKey() ? `${provider}:configured` : `${provider}:missing_key`,
    };
  }
  if (provider !== 'openai') {
    return { ok: false, detail: `${provider}:unsupported_provider` };
  }
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
  let trusted = false;
  if (deep) {
    const secret = env.slaWorkerSecret();
    trusted = Boolean(secret) && verifyBearer(req, secret);
    if (!trusted) {
      const allowed = await checkRateLimit(getServiceSupabase(), {
        key: `healthz:${clientIdentifier(req)}`,
        windowSeconds: 60,
        maxRequests: 20,
      });
      if (!allowed) return jsonResponse(req, { error: 'Rate limit exceeded' }, 429);
    }
    const [db, cron] = await Promise.all([checkDb(), checkLastNightlyRun()]);
    checked.db = db;
    checked.cron = cron;
    checked.ai = checkAiProvider();
  }

  const everythingOk = Object.values(checked).every((c) => c.ok);
  const visible: Record<string, Check> = trusted
    ? checked
    : Object.fromEntries(Object.entries(checked).map(([k, c]) => [k, { ok: c.ok, latencyMs: c.latencyMs }]));
  const payload = {
    ok: !deep || everythingOk,
    service: 'karnaf-crm-edge',
    deno: trusted ? Deno.version : undefined,
    checked: visible,
    correlationId,
    generatedAt: new Date().toISOString(),
  };

  if (deep && !everythingOk) {
    log.warn('healthz_deep_failed', { fn: 'healthz', correlationId, checked });
  }
  return jsonResponse(req, payload, payload.ok ? 200 : 503);
});
