import { jsonResponse, preflight } from '../_shared/cors.ts';
import { normalizeIsraeliPhone } from '../_shared/phone.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { transitionLeadStatus, logLeadEvent } from '../_shared/lead-service.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { ensureProgramMember } from '../_shared/member-service.ts';
import { runMatchingRules } from '../_shared/automation-engine.ts';
import { buildLeadContext } from '../_shared/event-context.ts';
import { verifyHmacHeader } from '../_shared/webhook-signature.ts';
import { env, optional, safeEqual } from '../_shared/env.ts';
import { normalizePaymentPayload, parseFormEncoded } from '../_shared/payment-normalize.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { checkRateLimit, clientIdentifier } from '../_shared/rate-limit.ts';
import { buildCapiEvent, buildUserData } from '../_shared/meta-capi.ts';
import { sendCapiEvents } from '../_shared/meta-capi-send.ts';

const PAID_STATUSES = new Set(['paid', 'completed', 'success', 'approved']);

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  const rawBody = await req.text();
  const url = new URL(req.url);
  const providerParam = (url.searchParams.get('provider') ?? '').toLowerCase() || null;

  // Fail-closed: PAYMENT_WEBHOOK_SECRET must be set in production. A missing
  // secret used to skip verification entirely — which would let an attacker
  // submit forged payment-completion events. WEBHOOK_ALLOW_UNSIGNED=true is
  // the explicit dev-only opt-out.
  //
  // Static-token lane (Tier 8.B pattern, like Rav Messer intake): some
  // Israeli PSPs (Grow) can't sign HMAC. When PAYMENT_STATIC_TOKEN is
  // set, a safelisted ?provider with a matching ?token= is accepted.
  // HMAC remains the preferred lane and always wins when it verifies.
  const secret = env.paymentWebhookSecret();
  const staticToken = env.paymentStaticToken();
  const tokenParam = url.searchParams.get('token') ?? '';
  const staticTokenOk = !!staticToken && providerParam === 'grow' &&
    !!tokenParam && safeEqual(tokenParam, staticToken);
  if (!secret && !staticToken) {
    if (optional('WEBHOOK_ALLOW_UNSIGNED') !== 'true') {
      log.error('payment_webhook_misconfigured', { fn: 'payment-webhook', correlationId });
      return jsonResponse(req, { error: 'Webhook not configured' }, 503);
    }
  } else {
    const hmacOk = !!secret && (
      (await verifyHmacHeader(req, rawBody, secret, 'x-karnaf-signature')) ||
      (await verifyHmacHeader(req, rawBody, secret, 'x-signature')) ||
      (await verifyHmacHeader(req, rawBody, secret, 'x-hub-signature-256'))
    );
    if (!hmacOk && !staticTokenOk) {
      log.warn('payment_signature_invalid', { fn: 'payment-webhook', correlationId });
      return jsonResponse(req, { error: 'Invalid signature' }, 401);
    }
  }

  // PSPs post JSON or form-encoded; accept both, then map any known
  // provider's field names onto the generic shape.
  let payload: Record<string, unknown>;
  const contentType = (req.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('application/x-www-form-urlencoded')) {
    payload = parseFormEncoded(rawBody);
  } else {
    try { payload = JSON.parse(rawBody); } catch {
      return jsonResponse(req, { error: 'Invalid JSON' }, 400);
    }
  }
  const normalized = normalizePaymentPayload(providerParam, payload);

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

  const orderId = normalized.order_id ?? undefined;
  const phone = normalizeIsraeliPhone(normalized.phone);
  const email = normalized.email?.toLowerCase().trim() ?? null;
  const productCode = normalized.product_code;
  const paymentStatus = normalized.payment_status;

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
      payment_provider: normalized.provider,
      product_code: productCode ?? null,
      payment_status: paymentStatus,
      amount: normalized.amount,
      currency: normalized.currency,
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
    const linkSource = normalized.link_source;
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
          value: normalized.amount,
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
          value: normalized.amount,
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
    // Meta CAPI Purchase — fire-and-forget, no-op until META_PIXEL_ID +
    // META_CAPI_TOKEN are provisioned. event_id is stable per order so
    // provider retries dedup on Meta's side.
    try {
      const { data: capiLead } = await supabase
        .from('leads')
        .select('email, phone, fbp, fbc')
        .eq('id', matchedLeadId)
        .maybeSingle();
      const userData = await buildUserData({
        email: (capiLead?.email as string | null) ?? email,
        phone: (capiLead?.phone as string | null) ?? phone,
        fbp: (capiLead?.fbp as string | null) ?? null,
        fbc: (capiLead?.fbc as string | null) ?? null,
      });
      await sendCapiEvents([
        buildCapiEvent({
          eventName: 'Purchase',
          eventId: orderId ? `purchase-${orderId}` : `purchase-${correlationId}`,
          eventTimeSec: Date.now() / 1000,
          userData,
          value: normalized.amount ?? undefined,
          currency: normalized.currency,
        }),
      ], correlationId);
    } catch (capiErr) {
      log.warn('capi_purchase_failed', { fn: 'payment-webhook', correlationId, err: String(capiErr) });
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
  // 'course' also matches course_5490 — the hosted-checkout product code
  // for the flagship program (docs: DEPLOYMENT.md "חיבור סליקה").
  if (!raw || raw.includes('program') || raw.includes('digital') || raw.includes('course') || raw.includes('תכנית') || raw.includes('תוכנית')) return 'program';
  if (raw.includes('investor') || raw.includes('mentorship') || raw.includes('משקיע')) return 'investor_mentorship';
  if (raw.includes('presale') || raw.includes('contractor') || raw.includes('פריסייל')) return 'presale';
  return null;
}
