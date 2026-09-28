// operator-digest — hourly roll-up, sent ONLY when something new happened.
//
// The owner's requirement, verbatim: "אפשר כל שעה אבל רק אם יש משהו חדש".
// So the watermark is the last digest that was actually delivered, and
// everything reported is measured against it. An hour in which nothing
// arrived produces no message at all — which is what makes the ones that do
// arrive worth opening.
//
// Also acts as the WhatsApp connection watchdog. It used to alert when no
// CUSTOMER message arrived for 6 hours. On 28.9 the owner moved the
// website's WhatsApp button to his own business number (few inquiries, he
// answers them himself), so customer silence on the CRM number is now the
// normal state and that alert fired every 6 hours for nothing. What still
// proves the connection is alive: Meta sends a delivery receipt to
// whatsapp-webhook for every message the CRM sends (the 05:00 daily summary
// alone guarantees one a day), and since #93 those receipts are recorded.
// So the alert is now "Meta sent us nothing at all for
// WEBHOOK_SILENCE_ALERT_HOURS" — a lapsed subscription, token or webhook
// override — and customer silence alone never alerts.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { env, optional } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { lastAlertAt, notifyOperator } from '../_shared/operator-alert.ts';

const APP_BASE_URL = 'https://karnaf-crm.vercel.app';

// How long whatsapp-webhook may go without ANY delivery from Meta (receipt
// or customer message) before that becomes the alert. 36h tolerates a quiet
// day with only the daily summary going out, but not two.
const WEBHOOK_SILENCE_ALERT_HOURS = 36;

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

    const [inbound, newLeads, newQueue, dlq, lastDelivery] = await Promise.all([
      countSince(supabase, 'messages', 'created_at', since, (q) => q.eq('direction', 'inbound')),
      countSince(supabase, 'leads', 'created_at', since),
      countSince(supabase, 'work_queue', 'created_at', since, (q) => q.eq('status', 'pending')),
      countSince(supabase, 'outbound_dispatch', 'created_at', since, (q) => q.eq('status', 'dlq')),
      newestWebhookDeliveryAt(supabase),
    ]);

    // ── The connection watchdog runs regardless of whether the digest fires ──
    // A failed lookup (ok=false) never alerts: a database hiccup must not
    // page the owner about WhatsApp.
    const webhookSilentHours = !lastDelivery.ok
      ? null
      : lastDelivery.at
        ? (now - Date.parse(lastDelivery.at)) / 3600_000
        : Number.POSITIVE_INFINITY;
    let silenceAlerted = false;
    if (webhookSilentHours !== null && webhookSilentHours >= WEBHOOK_SILENCE_ALERT_HOURS) {
      const result = await notifyOperator(supabase, {
        kind: 'intake_silence',
        dedupeKey: 'intake_silence',
        // Twice a day while it lasts: present, not noise.
        throttleMinutes: (WEBHOOK_SILENCE_ALERT_HOURS / 3) * 60,
        severity: 'critical',
        title: '🔌 מטא הפסיקה לשלוח עדכונים ל-CRM — ייתכן שהחיבור לוואטסאפ נותק',
        lines: [
          lastDelivery.at
            ? `העדכון האחרון ממטא: ${new Date(lastDelivery.at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })} (לפני ${Math.round(webhookSilentHours)} שעות)`
            : 'מעולם לא התקבל עדכון ממטא.',
          'הודעות שנשלחות מה-CRM לא מקבלות אישור מסירה, ותשובות של לקוחות למספר ה-CRM לא יגיעו.',
          'לבדיקה: דוח ה-ops, חלק "whatsapp channel status (from Meta)".',
        ],
        link: `${APP_BASE_URL}/settings`,
        correlationId,
      });
      silenceAlerted = result.delivered;
    }

    const hasNews = inbound > 0 || newLeads > 0 || newQueue > 0 || dlq > 0;
    if (!hasNews) {
      log.info('operator_digest_quiet', { fn: 'operator-digest', correlationId, since, webhookSilentHours });
      return jsonResponse(req, {
        ok: true, sent: false, reason: 'nothing_new', since, silenceAlerted,
        webhookSilentHours: webhookSilentHours === null ? null : Math.round(webhookSilentHours * 10) / 10,
        correlationId,
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
      since, counts: { inbound, newLeads, newQueue, dlq }, silenceAlerted,
      webhookSilentHours: webhookSilentHours === null ? null : Math.round(webhookSilentHours * 10) / 10,
      correlationId,
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

/** Newest call Meta made to whatsapp-webhook — receipt or customer message. */
async function newestWebhookDeliveryAt(
  supabase: ReturnType<typeof getServiceSupabase>,
): Promise<{ ok: boolean; at: string | null }> {
  const { data, error } = await supabase
    .from('webhook_inbox')
    .select('received_at')
    .eq('source', 'whatsapp-webhook')
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    log.warn('operator_digest_last_delivery_failed', { fn: 'operator-digest', err: error.message });
    return { ok: false, at: null };
  }
  return { ok: true, at: (data?.received_at as string | undefined) ?? null };
}
