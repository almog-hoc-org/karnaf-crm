// Worker that drains the outbound_dispatch queue. Triggered every
// minute by pg_cron (see migration 036). Claims a small batch and, per
// row, either:
//   * sends an outbound template/broadcast message directly via the
//     WhatsApp provider (rows carrying payload.kind='template', e.g.
//     the webinar confirmation or a broadcast), or
//   * delegates to orchestrate-message for the AI-reply path (inbound
//     retries) — the original behaviour.
//
// The direct-send branch exists because orchestrate-message requires a
// conversation and runs the full AI pipeline; a cold-audience template
// (a lead who never wrote to the bot) has neither. Splitting the two
// here keeps the AI path untouched while letting engine/broadcast sends
// actually reach WhatsApp.
//
// Authenticated with a shared secret — same pattern as sla-worker.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { env } from '../_shared/env.ts';
import { correlationFromRequest, log, newCorrelationId } from '../_shared/logger.ts';
import {
  activeProvider,
  sendWhatsAppTemplate,
  sendWhatsAppText,
} from '../_shared/whatsapp-provider.ts';
import { ensureConversation } from '../_shared/lead-service.ts';
import type { TemplateParam } from '../_shared/provider-types.ts';

interface DispatchRow {
  id: string;
  lead_id: string;
  conversation_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  correlation_id: string | null;
}

const BATCH_SIZE = 10;
const ORCHESTRATE_TIMEOUT_MS = 25_000;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  const secret = env.outboundDispatchSecret();
  if (!secret) {
    log.warn('outbound_dispatch_secret_missing', { fn: 'dispatch-outbound', correlationId });
    return jsonResponse(req, { error: 'Worker secret not configured' }, 503);
  }
  if (!verifyBearer(req, secret)) {
    return jsonResponse(req, { error: 'Unauthorized' }, 401);
  }

  const supabase = getServiceSupabase();
  const { data: claimed, error: claimErr } = await supabase.rpc('claim_outbound_dispatch', {
    p_batch_size: BATCH_SIZE,
  });
  if (claimErr) {
    log.error('claim_failed', { fn: 'dispatch-outbound', correlationId, err: claimErr.message });
    return jsonResponse(req, { error: claimErr.message }, 500);
  }
  const rows = (claimed ?? []) as DispatchRow[];

  if (rows.length === 0) {
    return jsonResponse(req, { ok: true, processed: 0 });
  }

  const orchestrateUrl = `${env.supabaseUrl()}/functions/v1/orchestrate-message`;

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    const rowCorrelationId = row.correlation_id ?? newCorrelationId();
    const payload = (row.payload ?? {}) as Record<string, unknown>;

    // Direct-send path: an outbound template / broadcast message that
    // carries its own content. Everything else is an AI-reply retry.
    if (payload.kind === 'template') {
      try {
        const outcome = await sendDirectTemplate(supabase, row, rowCorrelationId);
        if (outcome.status === 'sent') {
          await supabase.rpc('complete_outbound_dispatch', { p_id: row.id });
          succeeded += 1;
        } else {
          // Terminal skip (DNC / no phone / unsupported channel). Not a
          // failure — no retry, but the recipient is marked so broadcast
          // analytics reflect it.
          await supabase.rpc('complete_outbound_dispatch', { p_id: row.id });
          skipped += 1;
          log.info('dispatch_template_skipped', {
            fn: 'dispatch-outbound', correlationId: rowCorrelationId,
            dispatchId: row.id, reason: outcome.reason,
          });
        }
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        log.error('dispatch_template_failed', {
          fn: 'dispatch-outbound', correlationId: rowCorrelationId,
          dispatchId: row.id, attempt: row.attempts, err: message,
        });
        await markBroadcastRecipient(supabase, row, { status: 'failed', error: message.slice(0, 300) });
        await supabase.rpc('fail_outbound_dispatch', { p_id: row.id, p_error: message });
      }
      continue;
    }

    try {
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), ORCHESTRATE_TIMEOUT_MS);
      const res = await fetch(orchestrateUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.serviceRoleKey()}`,
          'Content-Type': 'application/json',
          'x-correlation-id': rowCorrelationId,
        },
        body: JSON.stringify({
          leadId: row.lead_id,
          conversationId: row.conversation_id,
          ...payload,
        }),
        signal: ac.signal,
      }).finally(() => clearTimeout(timeout));

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`orchestrate ${res.status}: ${text.slice(0, 200)}`);
      }

      await supabase.rpc('complete_outbound_dispatch', { p_id: row.id });
      succeeded += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      log.error('dispatch_attempt_failed', {
        fn: 'dispatch-outbound',
        correlationId: rowCorrelationId,
        dispatchId: row.id,
        attempt: row.attempts,
        err: message,
      });
      await supabase.rpc('fail_outbound_dispatch', { p_id: row.id, p_error: message });
    }
  }

  log.info('dispatch_batch_done', {
    fn: 'dispatch-outbound', correlationId, processed: rows.length, succeeded, failed, skipped,
  });
  return jsonResponse(req, { ok: true, processed: rows.length, succeeded, failed, skipped });
});

interface LeadForSend {
  id: string;
  phone: string | null;
  full_name: string | null;
  do_not_contact: boolean | null;
  removed_by_request: boolean | null;
}

type SendOutcome = { status: 'sent' } | { status: 'skipped'; reason: string };

// Send one outbound template/broadcast row via the WhatsApp provider.
// Returns 'sent' or a terminal 'skipped'; throws on a transient send
// failure so the caller reschedules a retry through fail_outbound_dispatch.
async function sendDirectTemplate(
  supabase: ReturnType<typeof getServiceSupabase>,
  row: DispatchRow,
  correlationId: string,
): Promise<SendOutcome> {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const channel = (payload.channel as string | undefined) ?? 'whatsapp';
  const text = (payload.text as string | undefined) ?? '';
  const metaTemplate = (payload.meta_template as Record<string, unknown> | undefined) ?? null;

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('id, phone, full_name, do_not_contact, removed_by_request')
    .eq('id', row.lead_id)
    .maybeSingle();
  if (leadErr) throw new Error(`lead lookup: ${leadErr.message}`);
  if (!lead) return skip(supabase, row, 'lead_not_found');

  const l = lead as LeadForSend;
  // Never message a suppressed lead. Terminal skip — broadcast analytics
  // count it as skipped, not failed.
  if (l.do_not_contact || l.removed_by_request) return skip(supabase, row, 'dnc_or_removed');
  // Phase 1 is WhatsApp-only; email broadcasts are gated off in the UI.
  if (channel !== 'whatsapp') return skip(supabase, row, `unsupported_channel:${channel}`);
  if (!l.phone) return skip(supabase, row, 'no_phone');
  if (activeProvider() === 'none') throw new Error('No WhatsApp provider configured');

  const sendResult = metaTemplate
    ? await sendWhatsAppTemplate(
        l.phone,
        String(metaTemplate.name),
        (Array.isArray(metaTemplate.params) ? metaTemplate.params : []) as TemplateParam[],
        typeof metaTemplate.lang === 'string' ? metaTemplate.lang : 'he',
      )
    : await sendWhatsAppText(l.phone, text);

  if (!sendResult.ok) {
    // Transient/provider error — surface to the retry machinery.
    throw new Error(sendResult.error ?? 'send failed');
  }

  // Persist a message row so the conversation timeline shows the send and
  // provider-status-webhook can roll delivered/read back to it (and, via
  // broadcast_recipients.message_id, to broadcast analytics).
  const conv = await ensureConversation(supabase, l.id, 'whatsapp', activeProvider());
  const contentText = text || (metaTemplate ? `[תבנית: ${metaTemplate.name}]` : '');
  const { data: msg } = await supabase.from('messages').insert({
    conversation_id: conv.id,
    lead_id: l.id,
    provider_message_id: sendResult.providerMessageId ?? null,
    sender_type: 'system',
    direction: 'outbound',
    message_type: 'template',
    content_text: contentText,
    provider_status: 'sent',
  }).select('id').maybeSingle();

  await markBroadcastRecipient(supabase, row, {
    status: 'sent',
    dispatch_id: row.id,
    message_id: (msg?.id as string | undefined) ?? null,
    provider_message_id: sendResult.providerMessageId ?? null,
    sent_at: new Date().toISOString(),
  });

  log.info('dispatch_template_sent', {
    fn: 'dispatch-outbound', correlationId, dispatchId: row.id, leadId: l.id,
    template: metaTemplate ? metaTemplate.name : null,
    broadcastId: payload.broadcast_id ?? null,
  });
  return { status: 'sent' };
}

async function skip(
  supabase: ReturnType<typeof getServiceSupabase>,
  row: DispatchRow,
  reason: string,
): Promise<SendOutcome> {
  await markBroadcastRecipient(supabase, row, { status: 'skipped', error: reason });
  return { status: 'skipped', reason };
}

// Reflect the send outcome onto broadcast_recipients when this dispatch
// belongs to a broadcast. No-op for engine/manual sends (no broadcast_id).
async function markBroadcastRecipient(
  supabase: ReturnType<typeof getServiceSupabase>,
  row: DispatchRow,
  fields: Record<string, unknown>,
): Promise<void> {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const broadcastId = payload.broadcast_id as string | undefined;
  if (!broadcastId) return;
  const { error } = await supabase
    .from('broadcast_recipients')
    .update(fields)
    .eq('broadcast_id', broadcastId)
    .eq('lead_id', row.lead_id);
  if (error) {
    log.warn('broadcast_recipient_update_failed', {
      fn: 'dispatch-outbound', broadcastId, leadId: row.lead_id, err: error.message,
    });
  }
}
