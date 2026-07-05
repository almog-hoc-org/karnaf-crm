// Broadcast materialisation worker. Poked every minute by pg_cron
// (migration 085). For each due broadcast it:
//   1. flips status draft/scheduled → sending,
//   2. materialises broadcast_recipients from the segment (idempotent via
//      the unique(broadcast_id, lead_id) constraint),
//   3. enqueues a bounded batch of not-yet-queued recipients into
//      outbound_dispatch at priority 10 (so the bot always drains first),
//   4. when nothing is left to queue, flips status → sent and writes the
//      final counts.
//
// The actual WhatsApp send + per-recipient outcome happens in
// dispatch-outbound (the shared queue worker). This worker never sends.
//
// Authenticated with a shared secret — same pattern as dispatch-outbound.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { env } from '../_shared/env.ts';
import { correlationFromRequest, log, newCorrelationId } from '../_shared/logger.ts';
import { resolveSegmentLeadIds, type BroadcastSegment } from '../_shared/broadcast-segment.ts';

// How many broadcasts to advance per tick, and how many recipients to
// enqueue per broadcast per tick. Downstream, dispatch-outbound drains
// only BATCH_SIZE (10) per minute behind live bot traffic, so this cap
// just bounds queue growth — the real send throttle is downstream.
const MAX_BROADCASTS_PER_TICK = 3;
const ENQUEUE_CAP_PER_TICK = 500;
const MATERIALISE_CHUNK = 1_000;
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

  // Due = scheduled/sending, with scheduled_at in the past (or unset).
  const nowIso = new Date().toISOString();
  const { data: due, error: dueErr } = await supabase
    .from('broadcasts')
    .select('id, name, channel, template_key, meta_template, body_snapshot, segment, status, scheduled_at')
    .in('status', ['scheduled', 'sending'])
    .or(`scheduled_at.is.null,scheduled_at.lte.${nowIso}`)
    .order('scheduled_at', { ascending: true })
    .limit(MAX_BROADCASTS_PER_TICK);
  if (dueErr) {
    log.error('broadcast_due_query_failed', { fn: 'broadcast-dispatch', correlationId, err: dueErr.message });
    return jsonResponse(req, { error: dueErr.message }, 500);
  }

  const results: Array<Record<string, unknown>> = [];
  for (const b of due ?? []) {
    try {
      results.push(await advanceBroadcast(supabase, b as BroadcastRow, correlationId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('broadcast_advance_failed', { fn: 'broadcast-dispatch', correlationId, broadcastId: (b as BroadcastRow).id, err: msg });
      results.push({ id: (b as BroadcastRow).id, error: msg });
    }
  }

  return jsonResponse(req, { ok: true, advanced: results.length, results });
});

interface BroadcastRow {
  id: string;
  name: string;
  channel: 'whatsapp' | 'email';
  template_key: string | null;
  meta_template: Record<string, unknown> | null;
  body_snapshot: string | null;
  segment: BroadcastSegment | null;
  status: string;
  scheduled_at: string | null;
}

async function advanceBroadcast(
  supabase: ReturnType<typeof getServiceSupabase>,
  b: BroadcastRow,
  correlationId: string,
): Promise<Record<string, unknown>> {
  // Phase 1 is WhatsApp-only. An email broadcast that somehow got
  // scheduled is parked as failed rather than silently swallowed.
  if (b.channel !== 'whatsapp') {
    await supabase.from('broadcasts').update({ status: 'failed' }).eq('id', b.id);
    return { id: b.id, skipped: `unsupported_channel:${b.channel}` };
  }

  if (b.status === 'scheduled') {
    await supabase.from('broadcasts').update({ status: 'sending' }).eq('id', b.id);
  }

  // 1. Materialise recipients (idempotent). Only insert leads not already
  //    present for this broadcast; the unique constraint makes repeat
  //    ticks safe even without the pre-filter.
  const leadIds = await resolveSegmentLeadIds(supabase, b.segment ?? {}, true);
  let materialised = 0;
  for (let i = 0; i < leadIds.length; i += MATERIALISE_CHUNK) {
    const chunk = leadIds.slice(i, i + MATERIALISE_CHUNK).map((leadId) => ({
      broadcast_id: b.id,
      lead_id: leadId,
      status: 'pending',
    }));
    const { error } = await supabase
      .from('broadcast_recipients')
      .upsert(chunk, { onConflict: 'broadcast_id,lead_id', ignoreDuplicates: true });
    if (error) throw new Error(`materialise: ${error.message}`);
    materialised += chunk.length;
  }

  // 2. Enqueue a bounded batch of pending recipients.
  const { data: pending, error: pendErr } = await supabase
    .from('broadcast_recipients')
    .select('id, lead_id')
    .eq('broadcast_id', b.id)
    .eq('status', 'pending')
    .limit(ENQUEUE_CAP_PER_TICK);
  if (pendErr) throw new Error(`pending query: ${pendErr.message}`);

  let enqueued = 0;
  for (const r of pending ?? []) {
    const rowCorrelationId = newCorrelationId();
    const { data: disp, error: dispErr } = await supabase.from('outbound_dispatch').insert({
      lead_id: r.lead_id,
      priority: BROADCAST_PRIORITY,
      payload: {
        kind: 'template',
        channel: 'whatsapp',
        source: 'broadcast',
        broadcast_id: b.id,
        template_key: b.template_key,
        text: b.body_snapshot ?? '',
        meta_template: b.meta_template ?? undefined,
      },
      correlation_id: rowCorrelationId,
    }).select('id').maybeSingle();
    if (dispErr) {
      log.warn('broadcast_enqueue_failed', { fn: 'broadcast-dispatch', correlationId, broadcastId: b.id, leadId: r.lead_id, err: dispErr.message });
      continue;
    }
    // Flip pending → queued so the next tick doesn't re-enqueue this
    // recipient. dispatch-outbound moves it on to sent/skipped/failed.
    await supabase.from('broadcast_recipients')
      .update({ status: 'queued', dispatch_id: disp?.id ?? null })
      .eq('id', r.id);
    enqueued += 1;
  }

  // 3. If nothing pending remains, the broadcast is fully queued → done.
  const { count: stillPending } = await supabase
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', b.id)
    .eq('status', 'pending');

  const counts = await recipientCounts(supabase, b.id);
  const patch: Record<string, unknown> = {
    recipient_count: counts.total,
    sent_count: counts.sent,
    skipped_count: counts.skipped,
    failed_count: counts.failed,
  };
  if ((stillPending ?? 0) === 0) {
    patch.status = 'sent';
    patch.sent_at = new Date().toISOString();
  }
  await supabase.from('broadcasts').update(patch).eq('id', b.id);

  log.info('broadcast_tick', {
    fn: 'broadcast-dispatch', correlationId, broadcastId: b.id,
    materialised, enqueued, stillPending: stillPending ?? 0, done: (stillPending ?? 0) === 0,
  });
  return { id: b.id, materialised, enqueued, still_pending: stillPending ?? 0, done: (stillPending ?? 0) === 0 };
}

async function recipientCounts(supabase: ReturnType<typeof getServiceSupabase>, id: string) {
  const countBy = async (status: string) => {
    const { count } = await supabase
      .from('broadcast_recipients').select('id', { count: 'exact', head: true })
      .eq('broadcast_id', id).eq('status', status);
    return count ?? 0;
  };
  const { count: total } = await supabase
    .from('broadcast_recipients').select('id', { count: 'exact', head: true }).eq('broadcast_id', id);
  const [sent, skipped, failed] = await Promise.all([countBy('sent'), countBy('skipped'), countBy('failed')]);
  return { total: total ?? 0, sent, skipped, failed };
}
