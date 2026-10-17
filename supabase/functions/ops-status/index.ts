// ops-status — one screen's worth of "is the system actually working?".
//
// Built because the honest answer to the owner's "why did I get no alerts?"
// was that nothing in the product could tell him. The dashboard's red banner
// watched heartbeats and lied about them; the inbox showed a failed fetch as
// an empty queue; `webhook_inbox` had no writer; and whether the alert
// channels were even configured was knowable only by reading the source.
//
// Everything here is read-only and derived from tables the operator already
// owns. Secrets are reported as configured / not configured — never echoed.
//
// What "intake" means here changed on 28.9: the owner moved the website's
// WhatsApp button to his own number, so customer silence on the CRM number
// is normal. The connection is proven by Meta's delivery receipts reaching
// whatsapp-webhook (webhook_inbox), the same signal operator-digest alerts
// on. Customer inbound age is shown as information only.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { alertChannelStatus } from '../_shared/operator-alert.ts';
import { loadEmailChannel } from '../_shared/email-channel.ts';

// Same threshold as operator-digest's watchdog: one quiet day with only the
// 05:00 summary going out still produces a receipt; two do not.
const WEBHOOK_SILENCE_ALERT_HOURS = 36;
// DLQ rows are never purged, so an all-time count is a red light that never
// clears. A week is what sla-worker reports on too.
const DLQ_WINDOW_DAYS = 7;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'GET') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  try {
    await requireStaff(req, { allow: ['owner', 'admin'] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const supabase = getServiceSupabase();
  const now = Date.now();
  const since24h = new Date(now - 24 * 3600_000).toISOString();
  const sinceDlq = new Date(now - DLQ_WINDOW_DAYS * 24 * 3600_000).toISOString();

  const [
    lastInbound, lastOutbound, lastWebhook, heartbeats,
    dlqCount, inbound24h, outbound24h, lastAlerts, pendingQueue, emailCfg, alertsRefused7d,
  ] = await Promise.all([
    newest(supabase, 'messages', 'created_at', (q) => q.eq('direction', 'inbound')),
    newest(supabase, 'messages', 'created_at', (q) => q.eq('direction', 'outbound')),
    newest(supabase, 'webhook_inbox', 'received_at', (q) => q.eq('source', 'whatsapp-webhook')),
    listHeartbeats(supabase),
    count(supabase, 'outbound_dispatch', (q) => q.eq('status', 'dlq').gte('created_at', sinceDlq)),
    count(supabase, 'messages', (q) => q.eq('direction', 'inbound').gte('created_at', since24h)),
    count(supabase, 'messages', (q) => q.eq('direction', 'outbound').gte('created_at', since24h)),
    recentAlerts(supabase),
    count(supabase, 'work_queue', (q) => q.eq('status', 'pending')),
    loadEmailChannel(supabase).catch(() => null),
    // Alerts Meta accepted and then refused in a delivery receipt (131049
    // marketing cap, 131047 outside window) — recorded by the webhook since
    // this round. "delivered: true" in the ledger is a lie for these.
    count(supabase, 'operator_alerts', (q) =>
      q.gte('created_at', sinceDlq).like('channel_results->whatsapp->>receipt', 'failed:%')),
  ]);

  const channels = alertChannelStatus(emailCfg);
  const anyChannel = Object.values(channels).some(Boolean);

  // The verdicts are the point: a raw timestamp still requires the reader to
  // know what "normal" looks like.
  const hoursSinceInbound = lastInbound.value ? (now - Date.parse(lastInbound.value)) / 3600_000 : null;
  const hoursSinceWebhook = lastWebhook.value ? (now - Date.parse(lastWebhook.value)) / 3600_000 : null;
  const verdicts: Array<{ key: string; level: 'ok' | 'warn' | 'error'; text: string }> = [];

  if (!lastWebhook.ok) {
    verdicts.push({ key: 'intake', level: 'warn', text: 'לא ניתן לבדוק את חיבור הוואטסאפ כרגע (שגיאת שליפה)' });
  } else if (hoursSinceWebhook === null) {
    verdicts.push({ key: 'intake', level: 'error', text: 'מטא מעולם לא שלחה עדכון ל-CRM — החיבור לוואטסאפ לא הוקם' });
  } else if (hoursSinceWebhook > WEBHOOK_SILENCE_ALERT_HOURS) {
    verdicts.push({
      key: 'intake', level: 'error',
      text: `מטא לא שלחה שום עדכון כבר ${Math.round(hoursSinceWebhook)} שעות — ייתכן שהחיבור לוואטסאפ נותק`,
    });
  } else {
    const customerNote = hoursSinceInbound === null
      ? 'עדיין לא נרשמה הודעת לקוח'
      : `הודעת הלקוח האחרונה לפני ${Math.round(hoursSinceInbound)} שעות`;
    verdicts.push({
      key: 'intake', level: 'ok',
      text: `החיבור לוואטסאפ פעיל (עדכון ממטא לפני ${Math.round(hoursSinceWebhook * 10) / 10} שעות; ${customerNote})`,
    });
  }

  if (!anyChannel) {
    verdicts.push({
      key: 'alerts', level: 'error',
      text: 'לא מוגדר אף ערוץ התראה — המערכת לא תוכל להודיע לך על כלום',
    });
  } else {
    verdicts.push({
      key: 'alerts', level: 'ok',
      text: `ערוצי התראה פעילים: ${Object.entries(channels).filter(([, on]) => on).map(([n]) => n).join(', ')}`,
    });
  }
  if ((alertsRefused7d ?? 0) > 0) {
    verdicts.push({
      key: 'alerts_whatsapp_refused', level: 'warn',
      text: `${alertsRefused7d} התראות וואטסאפ ב-${DLQ_WINDOW_DAYS} הימים האחרונים התקבלו ע"י מטא ואז נדחו (לרוב 131049: תבנית ההתראה מסווגת שיווקית). הפתרון: תבנית UTILITY ייעודית להתראות — ראו המדריך לבעלים.`,
    });
  }

  if ((dlqCount ?? 0) > 0) {
    verdicts.push({
      key: 'dlq', level: 'error',
      text: `${dlqCount} הודעות נכשלו סופית ולא נשלחו ב-${DLQ_WINDOW_DAYS} הימים האחרונים`,
    });
  }

  log.info('ops_status_read', { fn: 'ops-status', correlationId });
  return jsonResponse(req, {
    ok: true,
    verdicts,
    intake: {
      lastInboundAt: lastInbound.value,
      lastOutboundAt: lastOutbound.value,
      lastWebhookAt: lastWebhook.value,
      webhookSilentHours: hoursSinceWebhook === null ? null : Math.round(hoursSinceWebhook * 10) / 10,
      inbound24h,
      outbound24h,
    },
    alerts: { channels, recent: lastAlerts, whatsappRefused7d: alertsRefused7d },
    workers: heartbeats,
    queue: { pending: pendingQueue, dlq: dlqCount, dlqWindowDays: DLQ_WINDOW_DAYS },
    correlationId,
  });
});

// deno-lint-ignore no-explicit-any
type Tweak = (q: any) => any;

// A failed sub-query must not take the whole page down — this screen's
// whole purpose is to be readable when things are broken. But "unknown" and
// "never" are different verdicts, so the caller gets both the value and
// whether the lookup worked.
async function newest(
  supabase: ReturnType<typeof getServiceSupabase>,
  table: string,
  column: string,
  tweak?: Tweak,
): Promise<{ ok: boolean; value: string | null }> {
  let q = supabase.from(table).select(column).order(column, { ascending: false }).limit(1);
  if (tweak) q = tweak(q);
  const { data, error } = await q.maybeSingle();
  if (error) {
    log.warn('ops_status_subquery_failed', { fn: 'ops-status', table, column, err: error.message });
    return { ok: false, value: null };
  }
  return { ok: true, value: (data as Record<string, string> | null)?.[column] ?? null };
}

async function count(
  supabase: ReturnType<typeof getServiceSupabase>,
  table: string,
  tweak?: Tweak,
): Promise<number | null> {
  let q = supabase.from(table).select('id', { count: 'exact', head: true });
  if (tweak) q = tweak(q);
  const { count: n, error } = await q;
  if (error) {
    log.warn('ops_status_count_failed', { fn: 'ops-status', table, err: error.message });
    return null;
  }
  return n ?? 0;
}

async function listHeartbeats(supabase: ReturnType<typeof getServiceSupabase>) {
  const { data, error } = await supabase
    .from('system_heartbeats')
    .select('name, last_ok_at, metadata')
    .order('name');
  if (error) return null;
  return data ?? [];
}

async function recentAlerts(supabase: ReturnType<typeof getServiceSupabase>) {
  const { data, error } = await supabase
    .from('operator_alerts')
    .select('kind, title, delivered, channel_results, created_at')
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) return null;
  return data ?? [];
}
