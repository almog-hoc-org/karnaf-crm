import { jsonResponse, preflight } from '../_shared/cors.ts';
import { normalizeIsraeliPhone } from '../_shared/phone.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { transitionLeadStatus, logLeadEvent } from '../_shared/lead-service.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { ensureProgramMember } from '../_shared/member-service.ts';
import { runMatchingRules } from '../_shared/automation-engine.ts';
import { buildLeadContext } from '../_shared/event-context.ts';
import { verifyHmacHeader } from '../_shared/webhook-signature.ts';
import { env, optional } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { checkRateLimit, clientIdentifier } from '../_shared/rate-limit.ts';

const PAID_STATUSES = new Set(['paid', 'completed', 'success', 'approved']);

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  const rawBody = await req.text();
  // Fail-closed: PAYMENT_WEBHOOK_SECRET must be set in production. A missing
  // secret used to skip verification entirely — which would let an attacker
  // submit forged payment-completion events. WEBHOOK_ALLOW_UNSIGNED=true is
  // the explicit dev-only opt-out.
  const secret = env.paymentWebhookSecret();
  if (!secret) {
    if (optional('WEBHOOK_ALLOW_UNSIGNED') !== 'true') {
      log.error('payment_webhook_misconfigured', { fn: 'payment-webhook', correlationId });
      return jsonResponse(req, { error: 'Webhook not configured' }, 503);
    }
  } else {
    const valid =
      (await verifyHmacHeader(req, rawBody, secret, 'x-karnaf-signature')) ||
      (await verifyHmacHeader(req, rawBody, secret, 'x-signature')) ||
      (await verifyHmacHeader(req, rawBody, secret, 'x-hub-signature-256'));
    if (!valid) {
      log.warn('payment_signature_invalid', { fn: 'payment-webhook', correlationId });
      return jsonResponse(req, { error: 'Invalid signature' }, 401);
    }
  }

  let payload: Record<string, unknown>;
  try { payload = JSON.parse(rawBody); } catch {
    return jsonResponse(req, { error: 'Invalid JSON' }, 400);
  }

  const supabase = getServiceSupabase();

  const allowed = await checkRateLimit(supabase, {
    key: `payment:${clientIdentifier(req)}`,
    windowSeconds: 60,
    maxRequests: 60,
  });
  if (!allowed) {
    log.warn('rate_limited', { fn: 'payment-webhook', correlationId, ip: clientIdentifier(req) });
    return jsonResponse(req, { error: 'Rate limit exceeded' }, 429);
  }

  const orderId = (payload.order_id || payload.transaction_id || payload.invoice_id) as string | undefined;
  const phone = normalizeIsraeliPhone(((payload.phone || payload.customer_phone || payload.mobile) as string | null) ?? null);
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase().trim() : null;
  const productCode = (payload.product_code || payload.product) as string | null | undefined;
  const paymentStatus = String(payload.payment_status || payload.status || 'unknown').toLowerCase();

  // Idempotency on order id.
  if (orderId) {
    const { data: existingEvent } = await supabase
      .from('payment_events')
      .select('id, lead_id')
      .eq('external_order_id', orderId)
      .maybeSingle();
    if (existingEvent) {
      log.info('payment_duplicate', { fn: 'payment-webhook', correlationId, orderId });
      return jsonResponse(req, { ok: true, duplicate: true });
    }
  }

  // Match priority: order_id → phone → email.
  let matchedLeadId: string | null = null;
  if (orderId) {
    const { data } = await supabase.from('leads').select('id').eq('payment_reference', orderId).maybeSingle();
    matchedLeadId = data?.id ?? null;
  }
  if (!matchedLeadId && phone) {
    const { data } = await supabase.from('leads').select('id').eq('phone', phone).maybeSingle();
    matchedLeadId = data?.id ?? null;
  }
  if (!matchedLeadId && email) {
    const { data } = await supabase.from('leads').select('id').eq('email', email).maybeSingle();
    matchedLeadId = data?.id ?? null;
  }

  // Persist the raw event regardless of match outcome (for analytics + manual review).
  const { data: eventRow, error: eventErr } = await supabase
    .from('payment_events')
    .insert({
      lead_id: matchedLeadId,
      external_order_id: orderId ?? null,
      external_customer_ref: (payload.customer_id ?? null) as string | null,
      payment_provider: (payload.provider ?? 'unknown') as string,
      product_code: productCode ?? null,
      payment_status: paymentStatus,
      amount: payload.amount ?? null,
      currency: (payload.currency ?? 'ILS') as string,
      payload_json: payload,
    })
    .select('id')
    .single();
  if (eventErr) {
    log.error('payment_persist_failed', { fn: 'payment-webhook', correlationId, err: eventErr.message });
    return jsonResponse(req, { error: 'Failed to persist payment event' }, 500);
  }

  if (!matchedLeadId) {
    // Ambiguous payment: queue for manual review so no money goes uncredited.
    await supabase.from('integration_logs').insert({
      source: 'payment_webhook',
      status: 'unmatched',
      request_data: payload,
      response_data: { reason: 'no_lead_match' },
    });
    log.warn('payment_unmatched', { fn: 'payment-webhook', correlationId, orderId });
    return jsonResponse(req, { ok: true, matched: false, eventId: eventRow.id });
  }

  if (PAID_STATUSES.has(paymentStatus)) {
    const linkSource = (payload.link_source ?? payload.source ?? null) as string | null;
    const paidTrack = resolvePaidTrack(productCode);
    const leadPaymentUpdates: Record<string, unknown> = {
      payment_status: 'paid',
      payment_reference: orderId ?? null,
      payment_completed_at: new Date().toISOString(),
      won_at: new Date().toISOString(),
    };
    if (paidTrack) leadPaymentUpdates.primary_track = paidTrack;
    await supabase.from('leads').update(leadPaymentUpdates).eq('id', matchedLeadId);
    let wonDealId: string | null = null;
    if (paidTrack) {
      const { data: existingDeal } = await supabase
        .from('deals')
        .select('id')
        .eq('lead_id', matchedLeadId)
        .eq('track', paidTrack)
        .eq('status', 'open')
        .maybeSingle();
      if (existingDeal?.id) {
        await supabase.from('deals').update({
          stage: paidTrack === 'program' ? 'paid_program_member' : 'closed_won',
          status: 'won',
          closed_at: new Date().toISOString(),
          value: payload.amount ?? null,
          metadata: { orderId: orderId ?? null, productCode, linkSource, correlationId },
        }).eq('id', existingDeal.id);
        wonDealId = existingDeal.id;
      } else {
        // Payment without a pre-existing open deal (e.g. a direct
        // checkout link). Create the won deal so the engine context and
        // reports see the sale — same rule mark_won enforces manually.
        const { data: createdDeal } = await supabase.from('deals').insert({
          lead_id: matchedLeadId,
          track: paidTrack,
          stage: paidTrack === 'program' ? 'paid_program_member' : 'closed_won',
          status: 'won',
          closed_at: new Date().toISOString(),
          value: payload.amount ?? null,
          metadata: { orderId: orderId ?? null, productCode, linkSource, correlationId },
        }).select('id').maybeSingle();
        wonDealId = createdDeal?.id ?? null;
      }
    }
    if (paidTrack === 'program') {
      await ensureProgramMember(supabase, {
        leadId: matchedLeadId,
        joinedVia: 'payment',
        actorType: 'provider',
        metadata: { orderId: orderId ?? null, productCode, linkSource, correlationId },
        correlationId,
      });
    }
    await transitionLeadStatus(supabase, matchedLeadId, 'won', 'provider', 'payment_completed');
    await logLeadEvent(supabase, matchedLeadId, 'payment_completed', 'provider', {
      order_id: orderId ?? null,
      product_code: productCode ?? null,
      link_source: linkSource,
      correlation_id: correlationId,
    });
    // Emit deal.won so the same bridges mark_won fires run here too
    // (program_14d onboarding journey, commissions). Best-effort — a
    // rule failure must not fail the payment ack.
    if (paidTrack) {
      try {
        const { data: wonDeal } = wonDealId
          ? await supabase
            .from('deals')
            .select('id, track, value, currency, partner_id, project_id')
            .eq('id', wonDealId)
            .maybeSingle()
          : { data: null };
        const leadCtxWon = await buildLeadContext(supabase, matchedLeadId);
        if (leadCtxWon) {
          await runMatchingRules(supabase, {
            triggerEvent: 'deal.won',
            context: { lead: leadCtxWon, deal: wonDeal ?? null },
            contactId: matchedLeadId,
            correlationId,
          });
        }
      } catch (err) {
        log.error('payment_deal_won_rules_failed', {
          fn: 'payment-webhook',
          correlationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else if (paymentStatus === 'pending' || paymentStatus === 'started') {
    await transitionLeadStatus(supabase, matchedLeadId, 'payment_pending', 'provider', 'payment_signal');
    await ensurePendingQueueItem(supabase, {
      leadId: matchedLeadId,
      queueType: 'payment_pending',
      priorityLevel: 2,
      reason: 'Payment in progress, monitor for completion',
      payloadJson: { orderId, paymentStatus },
    });
  } else if (paymentStatus === 'failed' || paymentStatus === 'declined') {
    await ensurePendingQueueItem(supabase, {
      leadId: matchedLeadId,
      queueType: 'payment_pending',
      priorityLevel: 1,
      reason: 'Payment failed - manual rescue needed',
      payloadJson: { orderId, paymentStatus },
    });
  }

  return jsonResponse(req, { ok: true, matchedLeadId, eventId: eventRow.id });
});

function resolvePaidTrack(productCode: string | null | undefined): string | null {
  const raw = String(productCode ?? '').toLowerCase();
  if (!raw || raw.includes('program') || raw.includes('digital') || raw.includes('course') || raw.includes('תכנית') || raw.includes('תוכנית')) return 'program';
  if (raw.includes('investor') || raw.includes('mentorship') || raw.includes('משקיע')) return 'investor_mentorship';
  if (raw.includes('presale') || raw.includes('contractor') || raw.includes('פריסייל')) return 'presale';
  return null;
}
