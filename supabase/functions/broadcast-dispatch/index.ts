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
import {
  addSubscriberToList,
  createRavmesserList,
  createRavmesserMessage,
  sendRavmesserMessage,
} from '../_shared/ravmesser.ts';
import { sanitizeEmailHtml, wrapEmailShell } from '../_shared/email-html.ts';

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

  // Email-channel config (Rav Messer campaign mode).
  const { data: emailCfgRow } = await supabase
    .from('crm_config').select('config_value').eq('config_key', 'email_channel').maybeSingle();
  const emailCfgRaw = (emailCfgRow?.config_value ?? {}) as Record<string, unknown>;
  const emailCfg = {
    fromName: typeof emailCfgRaw.fromName === 'string' ? emailCfgRaw.fromName : 'קרנף נדל"ן',
    fromEmail: typeof emailCfgRaw.fromEmail === 'string' ? emailCfgRaw.fromEmail : '',
    requireConsent: emailCfgRaw.requireConsent !== false,
  };

  for (const b of broadcasts) {
    try {
      // Email broadcasts ride Rav Messer list campaigns — a separate
      // lifecycle from the WhatsApp per-recipient queue.
      if ((b.channel ?? 'whatsapp') === 'email') {
        const used = await advanceEmailBroadcast(supabase, b, emailCfg, allowance, correlationId);
        allowance -= used;
        totalEnqueued += used;
        continue;
      }

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

      // 2. Reconcile 'enqueued' recipients against their actual queue
      //    items. Normally dispatch-outbound updates the recipient, but a
      //    missed update (worker death, dlq before the linkage existed)
      //    left recipients 'enqueued' forever and the broadcast stuck in
      //    'sending'. Terminal queue states are copied over; a recipient
      //    whose queue item vanished goes back to 'pending' for re-enqueue.
      const { data: enqueued } = await supabase
        .from('broadcast_recipients')
        .select('id, dispatch_id')
        .eq('broadcast_id', b.id)
        .eq('status', 'enqueued')
        .limit(200);
      const enqueuedRows = enqueued ?? [];
      if (enqueuedRows.length > 0) {
        const dispatchIds = enqueuedRows.map((r) => r.dispatch_id).filter(Boolean);
        const { data: dispatches } = dispatchIds.length > 0
          ? await supabase.from('outbound_dispatch').select('id, status, last_error').in('id', dispatchIds)
          : { data: [] };
        const byId = new Map((dispatches ?? []).map((d) => [d.id as string, d]));
        for (const r of enqueuedRows) {
          const d = r.dispatch_id ? byId.get(r.dispatch_id as string) : undefined;
          if (!d) {
            await supabase.from('broadcast_recipients')
              .update({ status: 'pending', dispatch_id: null })
              .eq('id', r.id);
            log.warn('broadcast_recipient_requeued', {
              fn: 'broadcast-dispatch', correlationId, broadcastId: b.id, recipientId: r.id,
            });
          } else if (d.status === 'succeeded') {
            await supabase.from('broadcast_recipients')
              .update({ status: 'sent', sent_at: new Date().toISOString() })
              .eq('id', r.id);
          } else if (d.status === 'dlq' || d.status === 'failed') {
            await supabase.from('broadcast_recipients')
              .update({ status: 'failed', error: (d.last_error as string | null)?.slice(0, 500) ?? 'dispatch failed' })
              .eq('id', r.id);
          }
          // pending / in_flight — a retry is still scheduled; leave as-is.
        }
      }

      // 3. Quality guard — if Meta is rejecting this broadcast's sends,
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

      // 4. Enqueue up to this tick's remaining pacing allowance.
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

      // 5. Finalise only when every recipient reached a TERMINAL state
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

// Email broadcast lifecycle (Rav Messer campaign mode):
//   scheduled → materialise consenting recipients with an email,
//   ensure a dedicated Responder list (provider_ref.listId),
//   push recipients into the list at the pacing allowance,
//   once everyone is pushed — create the message and send it to the
//   list, then finalise. Opens/clicks/unsubscribes live in Rav Messer.
// Returns how many recipients were pushed this tick (counts against
// the shared pacing allowance).
async function advanceEmailBroadcast(
  supabase: ReturnType<typeof getServiceSupabase>,
  b: Record<string, unknown>,
  emailCfg: { fromName: string; fromEmail: string; requireConsent: boolean },
  allowance: number,
  correlationId: string,
): Promise<number> {
  const broadcastId = b.id as string;

  if (b.status === 'scheduled') {
    const leads = await fetchSegmentLeads(
      supabase, (b.segment ?? {}) as BroadcastSegment, SEGMENT_FETCH_LIMIT,
      { channel: 'email', requireEmailConsent: emailCfg.requireConsent },
    );
    if (leads.length > 0) {
      await supabase.from('broadcast_recipients').upsert(
        leads.map((l) => ({ broadcast_id: broadcastId, lead_id: l.id, status: 'pending' })),
        { onConflict: 'broadcast_id,lead_id', ignoreDuplicates: true },
      );
    }
    await supabase.from('broadcasts')
      .update({ status: 'sending', recipients_count: leads.length })
      .eq('id', broadcastId);
  }

  const providerRef = { ...((b.provider_ref ?? {}) as Record<string, unknown>) };

  if (!providerRef.listId) {
    if (!emailCfg.fromEmail) {
      await failEmailBroadcast(supabase, broadcastId, correlationId, 'חסר fromEmail בהגדרת email_channel');
      return 0;
    }
    const list = await createRavmesserList({
      name: `karnaf-crm-${String(b.name ?? '').slice(0, 40)}-${broadcastId.slice(0, 8)}`,
      senderName: emailCfg.fromName,
      senderEmail: emailCfg.fromEmail,
    });
    if (!list.ok || !list.listId) {
      await failEmailBroadcast(supabase, broadcastId, correlationId, `יצירת רשימה ברב מסר נכשלה: ${list.error}`);
      return 0;
    }
    providerRef.listId = list.listId;
    await supabase.from('broadcasts').update({ provider_ref: providerRef }).eq('id', broadcastId);
  }

  // Push pending recipients into the Responder list, paced.
  let pushed = 0;
  if (allowance > 0) {
    const { data: pending } = await supabase
      .from('broadcast_recipients')
      .select('id, lead_id, leads(email, full_name, consent_email, do_not_contact)')
      .eq('broadcast_id', broadcastId)
      .eq('status', 'pending')
      .limit(allowance);
    for (const r of (pending ?? []) as unknown as Array<{
      id: string; lead_id: string;
      leads: { email: string | null; full_name: string | null; consent_email: boolean | null; do_not_contact: boolean | null } | null;
    }>) {
      const lead = r.leads;
      if (!lead?.email || lead.do_not_contact || (emailCfg.requireConsent && lead.consent_email !== true)) {
        await supabase.from('broadcast_recipients')
          .update({ status: 'skipped', error: !lead?.email ? 'no_email' : 'no_consent' })
          .eq('id', r.id);
        continue;
      }
      const added = await addSubscriberToList(providerRef.listId as string, {
        email: lead.email, name: lead.full_name,
      });
      if (added.ok) {
        await supabase.from('broadcast_recipients')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', r.id);
        pushed += 1;
      } else if (added.error === 'ravmesser: email invalid') {
        await supabase.from('broadcast_recipients')
          .update({ status: 'failed', error: 'invalid_email' })
          .eq('id', r.id);
      } else {
        // Transient (network / not configured) — leave pending for the
        // next tick, stop pushing this round.
        log.warn('broadcast_email_push_failed', {
          fn: 'broadcast-dispatch', correlationId, broadcastId, err: added.error,
        });
        break;
      }
    }
  }

  // Everyone pushed? Create + send the campaign message once.
  const { count: remaining } = await supabase
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending');
  if ((remaining ?? 0) === 0 && !providerRef.messageSent) {
    const bodyHtml = (b.body_html as string | null) ??
      `<p>${String(b.body_snapshot ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br />')}</p>`;
    const html = wrapEmailShell(sanitizeEmailHtml(bodyHtml), emailCfg.fromName);
    const counts = await finalCounts(supabase, broadcastId);

    if (counts.sent === 0) {
      // Nobody made it into the list — nothing to send.
      await supabase.from('broadcasts').update({
        status: counts.failed > 0 ? 'failed' : 'sent',
        sent_count: 0, failed_count: counts.failed, skipped_count: counts.skipped,
      }).eq('id', broadcastId);
      return pushed;
    }

    const msg = await createRavmesserMessage({
      listId: providerRef.listId as string,
      subject: String(b.subject ?? b.name ?? 'עדכון מקרנף נדל"ן'),
      html,
    });
    if (!msg.ok || !msg.messageId) {
      await failEmailBroadcast(supabase, broadcastId, correlationId, `יצירת הודעה ברב מסר נכשלה: ${msg.error}`);
      return pushed;
    }
    const sent = await sendRavmesserMessage(providerRef.listId as string, msg.messageId);
    if (!sent.ok) {
      await failEmailBroadcast(supabase, broadcastId, correlationId, `שליחת הקמפיין ברב מסר נכשלה: ${sent.error}`);
      return pushed;
    }
    providerRef.messageId = msg.messageId;
    providerRef.messageSent = true;
    providerRef.sentAt = new Date().toISOString();
    await supabase.from('broadcasts').update({
      status: 'sent',
      provider_ref: providerRef,
      sent_count: counts.sent,
      failed_count: counts.failed,
      skipped_count: counts.skipped,
    }).eq('id', broadcastId);
    log.info('broadcast_email_campaign_sent', {
      fn: 'broadcast-dispatch', correlationId, broadcastId,
      listId: providerRef.listId, messageId: msg.messageId, ...counts,
    });
  }

  return pushed;
}

async function failEmailBroadcast(
  supabase: ReturnType<typeof getServiceSupabase>,
  broadcastId: string,
  correlationId: string,
  reason: string,
): Promise<void> {
  await supabase.from('broadcasts').update({ status: 'failed' }).eq('id', broadcastId);
  await notifyTelegram({
    source: 'broadcast-dispatch',
    severity: 'warn',
    title: 'תפוצת מייל נכשלה',
    lines: [reason],
    correlationId,
  });
  log.warn('broadcast_email_failed', { fn: 'broadcast-dispatch', correlationId, broadcastId, reason });
}
