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
import { getServiceSupabase } from '../_shared/supabase.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { fetchSegmentLeads, type BroadcastSegment } from '../_shared/broadcast-segment.ts';

// How many broadcasts to advance per tick, and how many recipients to
// enqueue per broadcast per tick. The per-tick recipient cap paces the
// fill so a big launch doesn't dump thousands of rows at once; combined
// with LOW priority it keeps the bot responsive.
const MAX_BROADCASTS_PER_TICK = 3;
const ENQUEUE_CAP_PER_TICK = 100;
const SEGMENT_FETCH_LIMIT = 5000;
const BROADCAST_PRIORITY = 10;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  const secret = Deno.env.get('BROADCAST_DISPATCH_SECRET') ?? '';
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

      // 2. Enqueue a capped batch of pending recipients.
      const { data: pending } = await supabase
        .from('broadcast_recipients')
        .select('id, lead_id')
        .eq('broadcast_id', b.id)
        .eq('status', 'pending')
        .limit(ENQUEUE_CAP_PER_TICK);

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
      }

      // 3. Finalise when nothing is left to enqueue.
      const { count: remaining } = await supabase
        .from('broadcast_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', b.id)
        .eq('status', 'pending');
      if ((remaining ?? 0) === 0) {
        const counts = await finalCounts(supabase, b.id);
        await supabase.from('broadcasts').update({
          status: 'sent',
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

async function finalCounts(supabase: ReturnType<typeof getServiceSupabase>, broadcastId: string) {
  const { data } = await supabase
    .from('broadcast_recipients').select('status').eq('broadcast_id', broadcastId);
  const rows = (data ?? []) as Array<{ status: string }>;
  return {
    sent: rows.filter((r) => ['sent', 'delivered', 'read', 'enqueued'].includes(r.status)).length,
    failed: rows.filter((r) => r.status === 'failed').length,
    skipped: rows.filter((r) => r.status === 'skipped').length,
  };
}
