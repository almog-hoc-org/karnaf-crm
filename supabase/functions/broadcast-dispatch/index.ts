// Worker that materialises + paces scheduled broadcasts. Triggered every
// minute by pg_cron (see migration 085). For each due broadcast it:
//   1. flips scheduled → sending and materialises broadcast_recipients
//      (idempotent — unique(broadcast_id, lead_id)),
//   2. enqueues a capped batch of pending recipients into the shared
//      outbound_dispatch queue at LOW priority (10) so real-time bot
//      traffic (priority 0) always drains first — the bot never blocks,
//   3. finalises to 'sent' once every recipient has been enqueued.
//
// The actual WhatsApp send + DNC guard + Meta-template-by-name delivery
// happens in dispatch-outbound (the meta_template path). This worker only
// fills the queue; it never calls a provider directly.
//
// Authenticated with a shared secret — same pattern as dispatch-outbound.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { env } from '../_shared/env.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { fetchSegmentLeads, type BroadcastSegment } from '../_shared/broadcast-segment.ts';
import { enqueueAllowance, resolvePacing, shouldPauseBroadcast } from '../_shared/broadcast-pacing.ts';
import { notifyTelegram } from '../_shared/notify-telegram.ts';

// How many broadcasts to advance per tick. The per-tick enqueue rate and
// the rolling-24h cap come from crm_config 'broadcast_pacing' (see
// _shared/broadcast-pacing.ts) so a big launch drips out slowly instead
// of tripping Meta's messaging-limit tier; combined with LOW priority it
// keeps the bot responsive.
const MAX_BROADCASTS_PER_TICK = 3;
const SEGMENT_FETCH_LIMIT = 5000;
const BROADCAST_PRIORITY = 10;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  const secret = env.broadcastDispatchSecret();
  if (!secret) {
    log.warn('broadcast_dispatch_secret_missing', { fn: 'broadcast-dispatch', correlationId });
    return jsonResponse(req, { error: 'Worker secret not configured' }, 503);
  }
  if (!verifyBearer(req, secret)) return jsonResponse(req, { error: 'Unauthorized' }, 401);

  const supabase = getServiceSupabase();

  // Due broadcasts: scheduled and past their time, plus any already
  // 'sending' (multi-tick fills). Oldest scheduled first.
  const { data: due, error: dueErr } = await supabase
    .from('broadcasts')
    .select('*')
    .in('status', ['scheduled', 'sending'])
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(MAX_BROADCASTS_PER_TICK);
  if (dueErr) {
    log.error('broadcast_due_query_failed', { fn: 'broadcast-dispatch', correlationId, err: dueErr.message });
    return jsonResponse(req, { error: dueErr.message }, 500);
  }

  const broadcasts = due ?? [];
  let totalEnqueued = 0;

  // Pacing state for this tick: config + rolling-24h broadcast spend.
  const { data: pacingRow } = await supabase
    .from('crm_config').select('config_value').eq('config_key', 'broadcast_pacing').maybeSingle();
  const pacing = resolvePacing(pacingRow?.config_value);
  const { count: enqueuedLast24h } = await supabase
    .from('outbound_dispatch')
    .select('id', { count: 'exact', head: true })
    .not('payload->>broadcast_id', 'is', null)
    .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  let allowance = enqueueAllowance(pacing, enqueuedLast24h ?? 0);
  if (allowance === 0 && broadcasts.length > 0) {
    log.warn('broadcast_daily_cap_reached', {
      fn: 'broadcast-dispatch', correlationId, enqueuedLast24h, dailyCap: pacing.dailyCap,
    });
  }

  for (const b of broadcasts) {
    try {
      // 1. Materialise recipients once, on the transition into 'sending'.
      if (b.status === 'scheduled') {
        const leads = await fetchSegmentLeads(supabase, (b.segment ?? {}) as BroadcastSegment, SEGMENT_FETCH_LIMIT);
        if (leads.length === SEGMENT_FETCH_LIMIT) {
          log.warn('broadcast_segment_capped', {
            fn: 'broadcast-dispatch', correlationId, broadcastId: b.id, cap: SEGMENT_FETCH_LIMIT,
          });
        }
        if (leads.length > 0) {
          await supabase.from('broadcast_recipients').upsert(
            leads.map((l) => ({ broadcast_id: b.id, lead_id: l.id, status: 'pending' })),
            { onConflict: 'broadcast_id,lead_id', ignoreDuplicates: true },
          );
        }
        await supabase.from('broadcasts')
          .update({ status: 'sending', recipients_count: leads.length })
          .eq('id', b.id);
      }

      // 2. Quality guard — if Meta is rejecting this broadcast's sends,
      //    pause it before the number's quality rating pays the price.
      const progress = await finalCounts(supabase, b.id);
      if (shouldPauseBroadcast(pacing, progress.sent, progress.failed)) {
        await supabase.from('broadcasts').update({
          status: 'failed',
          sent_count: progress.sent,
          failed_count: progress.failed,
          skipped_count: progress.skipped,
        }).eq('id', b.id);
        await notifyTelegram({
          source: 'broadcast-dispatch',
          severity: 'warn',
          title: 'תפוצה הושהתה אוטומטית',
          lines: [
            `${progress.failed} מתוך ${progress.sent + progress.failed} שליחות נכשלו.`,
            'בדקו את התבנית ואת דירוג המספר לפני המשך.',
          ],
          correlationId,
        });
        log.warn('broadcast_paused_failure_rate', {
          fn: 'broadcast-dispatch', correlationId, broadcastId: b.id, ...progress,
        });
        continue;
      }

      // 3. Enqueue up to this tick's remaining pacing allowance.
      const { data: pending } = allowance > 0
        ? await supabase
            .from('broadcast_recipients')
            .select('id, lead_id')
            .eq('broadcast_id', b.id)
            .eq('status', 'pending')
            .limit(allowance)
        : { data: [] as Array<{ id: string; lead_id: string }> };

      const pendingRows = pending ?? [];
      const channel = b.channel ?? 'whatsapp';
      for (const r of pendingRows) {
        const { data: enq, error: enqErr } = await supabase.from('outbound_dispatch').insert({
          lead_id: r.lead_id,
          priority: BROADCAST_PRIORITY,
          payload: {
            kind: 'template',
            channel,
            text: b.body_snapshot ?? '',
            template_key: b.template_key ?? null,
            broadcast_id: b.id,
            ...(b.meta_template?.name
              ? { meta_template: { name: b.meta_template.name, lang: b.meta_template.lang ?? 'he', params: b.meta_template.params ?? [] } }
              : {}),
          },
          correlation_id: correlationId,
        }).select('id').maybeSingle();
        if (enqErr) {
          log.warn('broadcast_enqueue_failed', {
            fn: 'broadcast-dispatch', correlationId, broadcastId: b.id, leadId: r.lead_id, err: enqErr.message,
          });
          continue;
        }
        await supabase.from('broadcast_recipients')
          .update({ status: 'enqueued', dispatch_id: enq?.id ?? null })
          .eq('id', r.id);
        totalEnqueued += 1;
        allowance -= 1;
      }

      // 4. Finalise only when every recipient reached a TERMINAL state
      //    (sent / skipped / failed). 'pending' means not yet enqueued;
      //    'enqueued' means a dispatch is still in flight or retrying —
      //    finalising then would freeze counts mid-run (the old code
      //    even counted 'enqueued' as sent, so an all-failed broadcast
      //    reported 100% delivered).
      const { count: remaining } = await supabase
        .from('broadcast_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', b.id)
        .in('status', ['pending', 'enqueued']);
      if ((remaining ?? 0) === 0) {
        const counts = await finalCounts(supabase, b.id);
        await supabase.from('broadcasts').update({
          // An all-failed broadcast is 'failed', not 'sent' — the operator
          // must see it needs attention, not a green checkmark.
          status: counts.sent === 0 && counts.failed > 0 ? 'failed' : 'sent',
          sent_count: counts.sent,
          failed_count: counts.failed,
          skipped_count: counts.skipped,
        }).eq('id', b.id);
        log.info('broadcast_finalised', { fn: 'broadcast-dispatch', correlationId, broadcastId: b.id, ...counts });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('broadcast_advance_failed', { fn: 'broadcast-dispatch', correlationId, broadcastId: b.id, err: message });
      await supabase.from('broadcasts').update({ status: 'failed' }).eq('id', b.id);
    }
  }

  log.info('broadcast_dispatch_done', {
    fn: 'broadcast-dispatch', correlationId, broadcasts: broadcasts.length, enqueued: totalEnqueued,
  });
  return jsonResponse(req, { ok: true, broadcasts: broadcasts.length, enqueued: totalEnqueued });
});

// Recipient statuses are exclusive terminal buckets: sent / failed /
// skipped. delivered+read are NOT statuses — they're derived from the
// linked messages rows (see broadcasts/index.ts recipientStats), so a
// recipient is counted exactly once here.
async function finalCounts(supabase: ReturnType<typeof getServiceSupabase>, broadcastId: string) {
  const { data } = await supabase
    .from('broadcast_recipients').select('status').eq('broadcast_id', broadcastId);
  const rows = (data ?? []) as Array<{ status: string }>;
  return {
    sent: rows.filter((r) => r.status === 'sent').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    skipped: rows.filter((r) => r.status === 'skipped').length,
  };
}
