// Vercel Edge healthz endpoint for the web app.
//
// Two shapes:
//   GET /api/healthz           → liveness: 200 with version + git SHA.
//   GET /api/healthz?deep=1    → also pings Supabase REST to confirm
//                                downstream reachability + measures latency.
//
// Designed to be a cheap probe target for uptime monitors / load balancers.
// No auth required — payload contains no secrets. Cache-Control no-store
// so monitors never see stale 200s after an outage starts.

export const config = { runtime: 'edge' };

interface HealthPayload {
  ok: boolean;
  service: 'karnaf-crm-web';
  version: string;
  gitSha: string | null;
  region: string | null;
  checked: Record<string, { ok: boolean; latencyMs?: number; error?: string }>;
  generatedAt: string;
}

function readEnv(name: string): string | undefined {
  const v = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[name];
  return v && v.length > 0 ? v : undefined;
}

async function pingSupabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const url = readEnv('VITE_SUPABASE_URL') ?? readEnv('SUPABASE_URL');
  const anon = readEnv('VITE_SUPABASE_ANON_KEY') ?? readEnv('SUPABASE_ANON_KEY');
  if (!url || !anon) {
    return { ok: false, latencyMs: 0, error: 'env_missing' };
  }
  const started = performance.now();
  try {
    const r = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: anon, Authorization: `Bearer ${anon}` },
    });
    const latencyMs = Math.round(performance.now() - started);
    return { ok: r.ok, latencyMs, error: r.ok ? undefined : `status_${r.status}` };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      error: String((err as Error)?.message ?? err).slice(0, 200),
    };
  }
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const deep = url.searchParams.get('deep') === '1';

  const checked: HealthPayload['checked'] = {};
  if (deep) {
    checked.supabase = await pingSupabase();
  }

  const everythingOk = Object.values(checked).every((c) => c.ok);
  const payload: HealthPayload = {
    ok: !deep || everythingOk,
    service: 'karnaf-crm-web',
    version: readEnv('VERCEL_GIT_COMMIT_REF') ?? readEnv('npm_package_version') ?? 'unknown',
    gitSha: readEnv('VERCEL_GIT_COMMIT_SHA') ?? null,
    region: readEnv('VERCEL_REGION') ?? null,
    checked,
    generatedAt: new Date().toISOString(),
  };

  return new Response(JSON.stringify(payload, null, 2), {
    status: payload.ok ? 200 : 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
