// operator-digest — hourly roll-up, sent ONLY when something new happened.
//
// The owner's requirement, verbatim: "אפשר כל שעה אבל רק אם יש משהו חדש".
// So the watermark is the last digest that was actually delivered, and
// everything reported is measured against it. An hour in which nothing
// arrived produces no message at all — which is what makes the ones that do
// arrive worth opening.
//
// Also acts as the zero-traffic watchdog: if the whole system has not seen
// an inbound message for `SILENCE_ALERT_HOURS` during active hours, that is
// itself the news. Nothing detected that before — every watchdog counted
// existing work items, so an intake outage produced *fewer* alerts than
// normal operation, and the silence from 2026-08-28 onward went unnoticed.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { env, optional } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { lastAlertAt, notifyOperator } from '../_shared/operator-alert.ts';

const APP_BASE_URL = 'https://karnaf-crm.vercel.app';

// How long the system may go without a single inbound before that becomes
// the alert. Six hours spans a normal quiet evening but not a working day.
const SILENCE_ALERT_HOURS = 6;

// First run has no watermark. Look back one hour rather than over all of
// history, so enabling this does not open with a report on the whole year.
const DEFAULT_LOOKBACK_HOURS = 1;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  // Shares the SLA worker's secret: same trust boundary (pg_cron), one less
  // secret for the operator to provision.
  const expected = optional('OPERATOR_DIGEST_SECRET') || env.slaWorkerSecret();
  if (!expected) {
    log.error('operator_digest_secret_missing', { fn: 'operator-digest', correlationId });
    return jsonResponse(req, { error: 'Worker secret not configured' }, 500);
  }
  if (!verifyBearer(req, expected)) return jsonResponse(req, { error: 'Unauthorized' }, 401);

  try {
    const supabase = getServiceSupabase();
    const now = Date.now();

    const watermark = await lastAlertAt(supabase, 'hourly_digest');
    const since = watermark ?? new Date(now - DEFAULT_LOOKBACK_HOURS * 3600_000).toISOString();

    const [inbound, newLeads, newQueue, dlq, lastInbound] = await Promise.all([
      countSince(supabase, 'messages', 'created_at', since, (q) => q.eq('direction', 'inbound')),
      countSince(supabase, 'leads', 'created_at', since),
      countSince(supabase, 'work_queue', 'created_at', since, (q) => q.eq('status', 'pending')),
      countSince(supabase, 'outbound_dispatch', 'created_at', since, (q) => q.eq('status', 'dlq')),
      newestInboundAt(supabase),
    ]);

    // ── The silence watchdog runs regardless of whether the digest fires ──
    const silentHours = lastInbound
      ? (now - Date.parse(lastInbound)) / 3600_000
      : Number.POSITIVE_INFINITY;
    let silenceAlerted = false;
    if (silentHours >= SILENCE_ALERT_HOURS) {
      const result = await notifyOperator(supabase, {
        kind: 'intake_silence',
        dedupeKey: 'intake_silence',
        // Once every six hours while the silence lasts: enough to keep it
        // present without becoming the noise it is meant to cut through.
        throttleMinutes: SILENCE_ALERT_HOURS * 60,
        severity: 'critical',
        title: '🔇 אין הודעות נכנסות — ייתכן שהקליטה מנותקת',
        lines: [
          lastInbound
            ? `ההודעה הנכנסת האחרונה: ${new Date(lastInbound).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })} (לפני ${Math.round(silentHours)} שעות)`
            : 'לא נרשמה שום הודעה נכנסת במערכת.',
          'בדקו את חיבור ה-Webhook של WhatsApp במטא ואת מצב מספר הטלפון.',
        ],
        link: `${APP_BASE_URL}/settings`,
        correlationId,
      });
      silenceAlerted = result.delivered;
    }

    const hasNews = inbound > 0 || newLeads > 0 || newQueue > 0 || dlq > 0;
    if (!hasNews) {
      log.info('operator_digest_quiet', { fn: 'operator-digest', correlationId, since, silentHours });
      return jsonResponse(req, {
        ok: true, sent: false, reason: 'nothing_new', since, silenceAlerted, correlationId,
      });
    }

    const lines: string[] = [];
    if (inbound > 0) lines.push(`• הודעות נכנסות חדשות: ${inbound}`);
    if (newLeads > 0) lines.push(`• לידים חדשים: ${newLeads}`);
    if (newQueue > 0) lines.push(`• פריטים חדשים בתור הטיפול: ${newQueue}`);
    if (dlq > 0) lines.push(`• הודעות שנכשלו סופית: ${dlq}`);
    lines.push(`(מאז ${new Date(since).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })})`);

    const result = await notifyOperator(supabase, {
      kind: 'hourly_digest',
      dedupeKey: `hourly_digest:${since}`,
      // The "only if new" gate above is the throttle; a second one here
      // would drop legitimately new content.
      throttleMinutes: 0,
      severity: dlq > 0 ? 'error' : 'info',
      title: 'עדכון שעתי — מה חדש',
      lines,
      link: `${APP_BASE_URL}/inbox`,
      correlationId,
    });

    log.info('operator_digest_sent', {
      fn: 'operator-digest', correlationId, since,
      counts: { inbound, newLeads, newQueue, dlq }, delivered: result.delivered,
    });
    return jsonResponse(req, {
      ok: true, sent: true, delivered: result.delivered, channels: result.channels,
      since, counts: { inbound, newLeads, newQueue, dlq }, silenceAlerted, correlationId,
    });
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log.error('operator_digest_unhandled', { fn: 'operator-digest', correlationId, err: message });
    return jsonResponse(req, { ok: false, error: message, correlationId }, 500);
  }
});

// deno-lint-ignore no-explicit-any
type QueryTweak = (q: any) => any;

async function countSince(
  supabase: ReturnType<typeof getServiceSupabase>,
  table: string,
  column: string,
  since: string,
  tweak?: QueryTweak,
): Promise<number> {
  let q = supabase.from(table).select('id', { count: 'exact', head: true }).gte(column, since);
  if (tweak) q = tweak(q);
  const { count, error } = await q;
  if (error) {
    // A failed count must not silence the whole digest — report zero for
    // this line and let the others through.
    log.warn('operator_digest_count_failed', { fn: 'operator-digest', table, err: error.message });
    return 0;
  }
  return count ?? 0;
}

async function newestInboundAt(
  supabase: ReturnType<typeof getServiceSupabase>,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('messages')
    .select('created_at')
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    log.warn('operator_digest_last_inbound_failed', { fn: 'operator-digest', err: error.message });
    return null;
  }
  return (data?.created_at as string | undefined) ?? null;
}
