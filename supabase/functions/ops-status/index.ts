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

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { alertChannelStatus } from '../_shared/operator-alert.ts';

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
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();

  const [
    lastInbound, lastOutbound, lastWebhook, heartbeats,
    dlqCount, inbound24h, outbound24h, lastAlerts, pendingQueue,
  ] = await Promise.all([
    newest(supabase, 'messages', 'created_at', (q) => q.eq('direction', 'inbound')),
    newest(supabase, 'messages', 'created_at', (q) => q.eq('direction', 'outbound')),
    newest(supabase, 'webhook_inbox', 'created_at'),
    listHeartbeats(supabase),
    count(supabase, 'outbound_dispatch', (q) => q.eq('status', 'dlq')),
    count(supabase, 'messages', (q) => q.eq('direction', 'inbound').gte('created_at', since24h)),
    count(supabase, 'messages', (q) => q.eq('direction', 'outbound').gte('created_at', since24h)),
    recentAlerts(supabase),
    count(supabase, 'work_queue', (q) => q.eq('status', 'pending')),
  ]);

  const channels = alertChannelStatus();
  const anyChannel = Object.values(channels).some(Boolean);

  // The verdicts are the point: a raw timestamp still requires the reader to
  // know what "normal" looks like.
  const hoursSinceInbound = lastInbound ? (Date.now() - Date.parse(lastInbound)) / 3600_000 : null;
  const verdicts: Array<{ key: string; level: 'ok' | 'warn' | 'error'; text: string }> = [];

  if (hoursSinceInbound === null) {
    verdicts.push({ key: 'intake', level: 'error', text: 'לא נרשמה מעולם הודעה נכנסת' });
  } else if (hoursSinceInbound > 24) {
    verdicts.push({
      key: 'intake', level: 'error',
      text: `אין הודעה נכנסת כבר ${Math.round(hoursSinceInbound)} שעות — ייתכן שהקליטה מנותקת`,
    });
  } else if (hoursSinceInbound > 6) {
    verdicts.push({ key: 'intake', level: 'warn', text: `ההודעה הנכנסת האחרונה לפני ${Math.round(hoursSinceInbound)} שעות` });
  } else {
    verdicts.push({ key: 'intake', level: 'ok', text: 'הקליטה פעילה' });
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

  if (!lastWebhook) {
    verdicts.push({
      key: 'webhook', level: 'warn',
      text: 'לא נרשמה אף קריאת webhook — התיעוד הופעל לאחרונה, אז זה צפוי עד שתגיע הודעה',
    });
  }

  if ((dlqCount ?? 0) > 0) {
    verdicts.push({ key: 'dlq', level: 'error', text: `${dlqCount} הודעות נכשלו סופית ולא נשלחו` });
  }

  log.info('ops_status_read', { fn: 'ops-status', correlationId });
  return jsonResponse(req, {
    ok: true,
    verdicts,
    intake: {
      lastInboundAt: lastInbound,
      lastOutboundAt: lastOutbound,
      lastWebhookAt: lastWebhook,
      inbound24h,
      outbound24h,
    },
    alerts: { channels, recent: lastAlerts },
    workers: heartbeats,
    queue: { pending: pendingQueue, dlq: dlqCount },
    correlationId,
  });
});

// deno-lint-ignore no-explicit-any
type Tweak = (q: any) => any;

async function newest(
  supabase: ReturnType<typeof getServiceSupabase>,
  table: string,
  column: string,
  tweak?: Tweak,
): Promise<string | null> {
  let q = supabase.from(table).select(column).order(column, { ascending: false }).limit(1);
  if (tweak) q = tweak(q);
  const { data, error } = await q.maybeSingle();
  // A failed sub-query must not take the whole page down — this screen's
  // whole purpose is to be readable when things are broken.
  if (error) return null;
  return (data as Record<string, string> | null)?.[column] ?? null;
}

async function count(
  supabase: ReturnType<typeof getServiceSupabase>,
  table: string,
  tweak?: Tweak,
): Promise<number | null> {
  let q = supabase.from(table).select('id', { count: 'exact', head: true });
  if (tweak) q = tweak(q);
  const { count: n, error } = await q;
  if (error) return null;
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
