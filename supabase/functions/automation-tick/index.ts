import { jsonResponse, preflight } from '../_shared/cors.ts';
import { env } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { safeEqual } from '../_shared/env.ts';
import { advanceDueJourneys } from '../_shared/journey-runner.ts';
import { runBiweeklyStudentCheckins } from '../_shared/student-lifecycle.ts';
import { runLeadJourneyManager } from '../_shared/lead-journey-manager.ts';

function verifyAnyBearer(req: Request, expectedSecrets: string[]): boolean {
  const header = req.headers.get('authorization') || '';
  if (!header.toLowerCase().startsWith('bearer ')) return false;
  const provided = header.slice(7).trim();
  return expectedSecrets.some((secret) => secret && safeEqual(provided, secret));
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  const expectedSecrets = [env.automationTickSecret(), env.slaWorkerSecret()].filter(Boolean);
  if (expectedSecrets.length === 0) {
    log.error('automation_tick_secret_missing', { fn: 'automation-tick', correlationId });
    return jsonResponse(req, { error: 'Worker secret not configured' }, 500);
  }
  if (!verifyAnyBearer(req, expectedSecrets)) return jsonResponse(req, { error: 'Unauthorized' }, 401);

  const supabase = getServiceSupabase();
  const journeys = await advanceDueJourneys(supabase, correlationId);
  const studentCheckins = await runBiweeklyStudentCheckins(supabase, correlationId);
  const leadJourney = await runLeadJourneyManager(supabase, correlationId);
  await supabase.from('system_heartbeats').upsert({
    name: 'automation_tick',
    last_ok_at: new Date().toISOString(),
    last_run_id: correlationId,
    metadata: { journeys, studentCheckins, leadJourney },
  });
  log.info('automation_tick_run', { fn: 'automation-tick', correlationId, journeys, studentCheckins, leadJourney });
  return jsonResponse(req, { ok: true, correlationId, journeys, studentCheckins, leadJourney });
});
