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

  let staff: Awaited<ReturnType<typeof requireStaff>>;
  try {
    staff = await requireStaff(req, { allow: ['owner', 'admin'] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const supabase = getServiceSupabase();

  if (req.method === 'GET') {
    const config = await getRuntimeConfig(supabase);
    return jsonResponse(req, {
      ok: true,
      activeHours: normaliseActiveHours(config.activeHours),
      whatsappSession: normaliseWhatsAppSession(config.whatsappSession),
      followUpDelays: config.followUpDelays,
      slaThresholds: config.slaThresholds,
      forbiddenClaims: config.forbiddenClaims,
    });
  }

  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  async function persist(key: string, value: unknown, logEvent: string) {
    const { error } = await supabase
      .from('crm_config')
      .upsert({
        config_key: key,
        config_value: value,
        updated_by_user_id: staff.userId,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'config_key' });
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info(logEvent, { fn: 'runtime-config', correlationId, by: staff.userId, value });
    return jsonResponse(req, { ok: true, [toCamel(key)]: value });
  }

  switch (body.action) {
    case 'update_active_hours': {
      const validationError = validateActiveHours(body as Partial<ActiveHoursPayload>);
      if (validationError) return jsonResponse(req, { error: validationError }, 400);
      const activeHours = normaliseActiveHours({
        start: body.start as string,
        end: body.end as string,
        timezone: body.timezone as string,
        workingDays: body.workingDays as number[],
      });
      return await persist('active_hours', activeHours, 'runtime_config_active_hours_updated');
    }
    // Tier 8.D — the three crm_config keys an admin actually tunes,
    // promoted from SQL-only to the Settings UI. ai_runtime/product
    // stay developer-only on purpose.
    case 'update_follow_up_delays': {
      const v = {
        firstResponseMinutes: clampInt(body.firstResponseMinutes, 1, 24 * 60, 30),
        nurtureHours: clampInt(body.nurtureHours, 1, 24 * 30, 24),
        paymentPendingHours: clampInt(body.paymentPendingHours, 1, 24 * 14, 12),
      };
      return await persist('follow_up_delays', v, 'runtime_config_follow_up_delays_updated');
    }
    case 'update_sla_thresholds': {
      const v = {
        firstResponseWarnHours: clampInt(body.firstResponseWarnHours, 1, 168, 8),
        firstResponseHighWarnHours: clampInt(body.firstResponseHighWarnHours, 1, 168, 10),
        firstResponseBreachHours: clampInt(body.firstResponseBreachHours, 1, 168, 12),
        paymentPendingHours: clampInt(body.paymentPendingHours, 1, 168, 24),
      };
      if (!(v.firstResponseWarnHours <= v.firstResponseHighWarnHours && v.firstResponseHighWarnHours <= v.firstResponseBreachHours)) {
        return jsonResponse(req, { error: 'סדר הספים חייב להיות: התראה ≤ התראה גבוהה ≤ חריגה' }, 400);
      }
      return await persist('sla_thresholds', v, 'runtime_config_sla_thresholds_updated');
    }
    case 'update_forbidden_claims': {
      const raw = Array.isArray(body.claims) ? body.claims : null;
      if (!raw) return jsonResponse(req, { error: 'claims must be an array' }, 400);
      const claims = [...new Set(
        raw.filter((c): c is string => typeof c === 'string')
          .map((c) => c.trim())
          .filter((c) => c.length > 1 && c.length <= 120),
      )];
      if (claims.length === 0) return jsonResponse(req, { error: 'נדרשת לפחות הצהרה אסורה אחת' }, 400);
      if (claims.length > 50) return jsonResponse(req, { error: 'עד 50 הצהרות' }, 400);
      return await persist('forbidden_claims', claims, 'runtime_config_forbidden_claims_updated');
    }
    default:
      return jsonResponse(req, { error: 'Unsupported action' }, 400);
  }
});

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function toCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

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

function normaliseWhatsAppSession(input: { freeformWindowHours?: number; fallbackTemplateName?: string }) {
  const fallbackTemplateName = typeof input.fallbackTemplateName === 'string' ? input.fallbackTemplateName.trim() : '';
  const freeformWindowHours = Number.isFinite(input.freeformWindowHours) ? Math.max(1, Math.min(72, Math.round(input.freeformWindowHours ?? 24))) : 24;
  return {
    freeformWindowHours,
    fallbackTemplateName: fallbackTemplateName || 'karnaf_followup_v1',
    templateConfigured: Boolean(fallbackTemplateName),
    templateApprovalRequired: true,
  };
}
