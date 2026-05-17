import { jsonResponse, preflight } from '../_shared/cors.ts';
import { normalizeIsraeliPhone } from '../_shared/phone.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { transitionLeadStatus, logLeadEvent } from '../_shared/lead-service.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
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
    await supabase.from('leads').update({
      payment_status: 'paid',
      payment_reference: orderId ?? null,
      payment_completed_at: new Date().toISOString(),
      won_at: new Date().toISOString(),
    }).eq('id', matchedLeadId);
    await transitionLeadStatus(supabase, matchedLeadId, 'won', 'provider', 'payment_completed');
    await logLeadEvent(supabase, matchedLeadId, 'payment_completed', 'provider', {
      order_id: orderId ?? null,
      product_code: productCode ?? null,
      correlation_id: correlationId,
    });
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
