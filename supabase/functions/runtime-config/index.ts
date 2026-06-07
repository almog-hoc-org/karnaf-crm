// Owner/admin runtime configuration management for low-risk operational settings.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { getRuntimeConfig } from '../_shared/config-service.ts';

type ActiveHoursPayload = {
  action: 'update_active_hours';
  start: string;
  end: string;
  timezone: string;
  workingDays: number[];
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ALLOWED_TIMEZONES = new Set(['Asia/Jerusalem']);

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const correlationId = correlationFromRequest(req);

  let staff;
  try {
    staff = await requireStaff(req, { allow: ['owner', 'admin'] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const supabase = getServiceSupabase();

  if (req.method === 'GET') {
    const config = await getRuntimeConfig(supabase);
    return jsonResponse(req, { ok: true, activeHours: normaliseActiveHours(config.activeHours) });
  }

  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const body = (await req.json().catch(() => ({}))) as Partial<ActiveHoursPayload>;
  if (body.action !== 'update_active_hours') return jsonResponse(req, { error: 'Unsupported action' }, 400);

  const validationError = validateActiveHours(body);
  if (validationError) return jsonResponse(req, { error: validationError }, 400);

  const activeHours = normaliseActiveHours({
    start: body.start as string,
    end: body.end as string,
    timezone: body.timezone as string,
    workingDays: body.workingDays as number[],
  });

  const { error } = await supabase
    .from('crm_config')
    .upsert({
      config_key: 'active_hours',
      config_value: activeHours,
      updated_by_user_id: staff.userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'config_key' });
  if (error) return jsonResponse(req, { error: error.message }, 400);

  log.info('runtime_config_active_hours_updated', {
    fn: 'runtime-config',
    correlationId,
    by: staff.userId,
    activeHours,
  });

  return jsonResponse(req, { ok: true, activeHours });
});

function validateActiveHours(body: Partial<ActiveHoursPayload>): string | null {
  if (!body.start || !TIME_RE.test(body.start)) return 'start must be HH:MM';
  if (!body.end || !TIME_RE.test(body.end)) return 'end must be HH:MM';
  if (!body.timezone || !ALLOWED_TIMEZONES.has(body.timezone)) return 'unsupported timezone';
  if (!Array.isArray(body.workingDays)) return 'workingDays must be an array';
  const days = normaliseWorkingDays(body.workingDays);
  if (days.length === 0) return 'at least one working day is required';
  return null;
}

function normaliseActiveHours(input: { start: string; end: string; timezone: string; workingDays?: number[] }) {
  return {
    start: TIME_RE.test(input.start) ? input.start : '09:00',
    end: TIME_RE.test(input.end) ? input.end : '21:00',
    timezone: ALLOWED_TIMEZONES.has(input.timezone) ? input.timezone : 'Asia/Jerusalem',
    workingDays: normaliseWorkingDays(input.workingDays ?? [0, 1, 2, 3, 4]),
  };
}

function normaliseWorkingDays(days: number[]): number[] {
  return [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
}
