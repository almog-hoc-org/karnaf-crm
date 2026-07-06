// Worker that drains the outbound_dispatch queue. Triggered every
// minute by pg_cron (see migration 030). Claims a small batch, calls
// orchestrate-message per row, and marks success or schedules a retry
// with exponential backoff.
//
// Authenticated with a shared secret — same pattern as sla-worker.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { env } from '../_shared/env.ts';
import { correlationFromRequest, log, newCorrelationId } from '../_shared/logger.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendChannelText } from '../_shared/outbound-channel.ts';
import { activeProvider, sendWhatsAppTemplate } from '../_shared/whatsapp-provider.ts';
import { ensureConversation, logLeadEvent } from '../_shared/lead-service.ts';
import { isFreeformAllowed } from '../_shared/conversation-window.ts';
import { getRuntimeConfig } from '../_shared/config-service.ts';
import { fallbackTemplateParams } from '../_shared/provider-errors.ts';

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

// Tier 8.E1 — engine/journey template sends carry payload.kind='template'
// and no conversation_id. Routing them through orchestrate-message used
// to 400 on the missing conversationId, so every engine-driven template
// retried itself into the DLQ and never reached the customer. Send them
// directly instead. Returns 'sent' | 'skipped'; throws on transient
// failures so the caller's retry/backoff machinery applies.
async function deliverTemplateRow(
  supabase: SupabaseClient,
  row: DispatchRow,
  correlationId: string,
): Promise<'sent' | 'skipped'> {
  const payload = row.payload as {
    channel?: string;
    text?: string;
    template_key?: string;
    // Campaign/broadcast sends to cold contacts (outside the 24h window)
    // must go out as a pre-approved Meta template BY NAME, not wrapped in
    // the generic fallback template. When present we send it directly.
    meta_template?: { name: string; lang?: string; params?: string[] };
    broadcast_id?: string;
  };
  const markRecipientSkipped = async (reason: string) => {
    if (!payload.broadcast_id) return;
    await supabase
      .from('broadcast_recipients')
      .update({ status: 'skipped', error: reason })
      .eq('broadcast_id', payload.broadcast_id)
      .eq('lead_id', row.lead_id);
  };

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    log.warn('template_dispatch_empty_text', {
      fn: 'dispatch-outbound', correlationId, dispatchId: row.id, templateKey: payload.template_key,
    });
    await markRecipientSkipped('empty_text');
    return 'skipped';
  }
  const channel = payload.channel || 'whatsapp';

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('id, phone, do_not_contact, removed_by_request, last_inbound_at')
    .eq('id', row.lead_id)
    .maybeSingle();
  if (leadErr) throw leadErr;
  if (!lead || lead.do_not_contact || lead.removed_by_request) {
    const reason = !lead ? 'lead_missing' : 'do_not_contact';
    log.info('template_dispatch_suppressed', {
      fn: 'dispatch-outbound', correlationId, dispatchId: row.id, leadId: row.lead_id, reason,
    });
    await markRecipientSkipped(reason);
    return 'skipped';
  }

  const conversation = await ensureConversation(supabase, row.lead_id, channel, activeProvider());

  const config = await getRuntimeConfig(supabase);
  const withinWindow = isFreeformAllowed(
    lead.last_inbound_at as string | null,
    config.whatsappSession.freeformWindowHours,
  );

  let sendResult;
  if (channel === 'whatsapp' && payload.meta_template?.name) {
    // Pre-approved Meta template sent by name — the correct path for
    // marketing/campaign sends to cold contacts. Positional body params
    // map to {{1}}, {{2}}, ... in the approved template.
    if (!lead.phone) { await markRecipientSkipped('no_phone'); return 'skipped'; }
    const params = (payload.meta_template.params ?? []).map((value, i) => ({
      name: String(i + 1),
      value,
    }));
    sendResult = await sendWhatsAppTemplate(
      lead.phone as string,
      payload.meta_template.name,
      params,
      payload.meta_template.lang ?? 'he',
    );
  } else if (channel === 'whatsapp' && !withinWindow) {
    // Outside the 24h session window only pre-approved templates pass.
    // Wrap the rendered text in the fallback template, same as
    // orchestrate-message does for AI replies.
    if (!lead.phone) { await markRecipientSkipped('no_phone'); return 'skipped'; }
    sendResult = await sendWhatsAppTemplate(
      lead.phone as string,
      config.whatsappSession.fallbackTemplateName,
      fallbackTemplateParams(text),
    );
  } else {
    sendResult = await sendChannelText(channel, lead, text);
  }
  if (!sendResult.ok) throw new Error(`template send failed: ${sendResult.error ?? 'unknown'}`);

  const { data: msg } = await supabase.from('messages').insert({
    conversation_id: conversation.id,
    lead_id: row.lead_id,
    provider_message_id: sendResult.providerMessageId ?? null,
    sender_type: 'system',
    direction: 'outbound',
    message_type: 'template',
    content_text: text,
    provider_status: 'sent',
    raw_payload: {
      source: payload.broadcast_id ? 'broadcast' : 'automation_engine',
      template_key: payload.template_key ?? null,
      meta_template: payload.meta_template?.name ?? null,
      broadcast_id: payload.broadcast_id ?? null,
    },
  }).select('id').maybeSingle();

  // Broadcast analytics — mark the recipient sent and link the message so
  // provider-status-webhook's delivered/read updates roll up per broadcast.
  if (payload.broadcast_id) {
    await supabase
      .from('broadcast_recipients')
      .update({
        status: 'sent',
        message_id: msg?.id ?? null,
        dispatch_id: row.id,
        sent_at: new Date().toISOString(),
      })
      .eq('broadcast_id', payload.broadcast_id)
      .eq('lead_id', row.lead_id);
  }

  await logLeadEvent(supabase, row.lead_id, 'automation_template_sent', 'system', {
    template_key: payload.template_key ?? null,
    channel,
    dispatch_id: row.id,
    broadcast_id: payload.broadcast_id ?? null,
  }, conversation.id);

  log.info('template_dispatch_sent', {
    fn: 'dispatch-outbound', correlationId, dispatchId: row.id, leadId: row.lead_id,
    templateKey: payload.template_key, metaTemplate: payload.meta_template?.name,
    broadcastId: payload.broadcast_id, channel, withinWindow,
  });
  return 'sent';
}

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

  for (const row of rows) {
    const rowCorrelationId = row.correlation_id ?? newCorrelationId();
    try {
      if (row.payload?.kind === 'template') {
        await deliverTemplateRow(supabase, row, rowCorrelationId);
        await supabase.rpc('complete_outbound_dispatch', { p_id: row.id });
        succeeded += 1;
        continue;
      }

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
          ...row.payload,
        }),
        signal: ac.signal,
      }).finally(() => clearTimeout(timeout));

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`orchestrate ${res.status}: ${text.slice(0, 200)}`);
      }

      // A locked conversation means another turn holds the advisory lock
      // (or the lock RPC errored and we failed closed). Completing the row
      // would silently drop this turn — retry with backoff instead.
      const resBody = await res.json().catch(() => ({} as Record<string, unknown>));
      if (resBody && (resBody as { skipped?: string }).skipped === 'locked') {
        throw new Error('orchestrate skipped: conversation locked');
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
    fn: 'dispatch-outbound', correlationId, processed: rows.length, succeeded, failed,
  });
  return jsonResponse(req, { ok: true, processed: rows.length, succeeded, failed });
});
