// Karnaf CRM → Student Portal handoff.
//
// Called when a paying lead should get access to the Student Portal. Generates
// a single-use invite code, registers it with the portal Supabase project
// (cross-project HTTP), and persists the code on the CRM lead row.
//
// Idempotent: if `leads.portal_invite_code` is already set, returns the
// existing code without re-issuing. This protects against payment-webhook
// retries and against operators clicking "resend" rapidly.
//
// Failure mode: if the portal call fails (timeout, 5xx, missing config), we
// queue a `failed_automation` work_queue item and return 502. The lead is
// NOT marked as provisioned — a retry will try afresh.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { logLeadEvent } from '../_shared/lead-service.ts';
import { verifyBearer } from '../_shared/webhook-signature.ts';
import { env } from '../_shared/env.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

interface ProvisionPayload {
  leadId: string;
  /** Optional cohort label persisted on the portal invite_codes row. */
  cohort?: string | null;
}

function generateInviteCode(): string {
  // 10 hex chars, upper-case. Collision space ~10^12, plenty for a single
  // operator's lifetime stream of paying customers; the unique index on
  // leads.portal_invite_code catches the impossible case.
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
}

function buildSignupLink(code: string): string {
  const base = env.portalBaseUrl().replace(/\/+$/, '');
  return `${base}/login?invite=${encodeURIComponent(code)}`;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  // Internal-only: same service-role bearer as orchestrate-message.
  if (!verifyBearer(req, env.serviceRoleKey())) {
    return jsonResponse(req, { error: 'Unauthorized' }, 401);
  }

  const correlationId = correlationFromRequest(req);
  const body = (await req.json().catch(() => ({}))) as Partial<ProvisionPayload>;
  const leadId = body.leadId;
  if (!leadId) return jsonResponse(req, { error: 'Missing leadId' }, 400);

  const portalUrl = env.portalSupabaseUrl();
  const portalKey = env.portalServiceRoleKey();
  if (!portalUrl || !portalKey) {
    log.error('portal_config_missing', { fn: 'provision-student', correlationId });
    return jsonResponse(req, { error: 'Portal not configured (PORTAL_SUPABASE_URL / PORTAL_SERVICE_ROLE_KEY)' }, 503);
  }

  const supabase = getServiceSupabase();

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('id, full_name, email, payment_status, portal_invite_code, portal_provisioned_at')
    .eq('id', leadId)
    .single();
  if (leadErr || !lead) return jsonResponse(req, { error: leadErr?.message ?? 'Lead not found' }, 404);

  if (lead.payment_status !== 'paid') {
    return jsonResponse(req, { error: `Lead payment_status is "${lead.payment_status}", expected "paid"` }, 409);
  }

  // Idempotent fast path: already provisioned. Return the existing code so
  // the caller can re-send the link without double-billing the portal.
  if (lead.portal_invite_code) {
    log.info('portal_already_provisioned', {
      fn: 'provision-student', correlationId, leadId, code: lead.portal_invite_code,
    });
    return jsonResponse(req, {
      ok: true,
      already: true,
      code: lead.portal_invite_code,
      signupUrl: buildSignupLink(lead.portal_invite_code),
      provisionedAt: lead.portal_provisioned_at,
    });
  }

  if (!lead.email) {
    // Portal requires email for sign-up. Without it we can't provision —
    // queue for manual review so Mia can collect the email.
    await ensurePendingQueueItem(supabase, {
      leadId,
      queueType: 'manual_review_required',
      priorityLevel: 1,
      reason: 'תלמיד שילם אך אין אימייל לרישום בפורטל',
      payloadJson: { correlationId },
    });
    return jsonResponse(req, { error: 'Lead has no email; portal sign-up requires one' }, 422);
  }

  const code = generateInviteCode();

  // Cross-project call to the portal's accept-invite Edge Function.
  const portalEndpoint = `${portalUrl.replace(/\/+$/, '')}/functions/v1/accept-invite`;
  let portalResponse: Response;
  try {
    portalResponse = await fetch(portalEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${portalKey}`,
        'Content-Type': 'application/json',
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify({
        code,
        email: lead.email,
        leadRef: leadId,
        cohort: body.cohort ?? null,
      }),
    });
  } catch (err) {
    log.error('portal_fetch_failed', { fn: 'provision-student', correlationId, leadId, err: String(err) });
    await ensurePendingQueueItem(supabase, {
      leadId,
      queueType: 'failed_automation',
      priorityLevel: 1,
      reason: 'קריאה לפורטל נכשלה — לרשום ידנית או לנסות שוב',
      queueSummary: String(err).slice(0, 200),
      payloadJson: { correlationId, code },
    });
    return jsonResponse(req, { error: 'Portal unreachable' }, 502);
  }

  if (!portalResponse.ok) {
    const portalErr = await portalResponse.text().catch(() => '');
    log.error('portal_responded_error', {
      fn: 'provision-student', correlationId, leadId, status: portalResponse.status,
      body: portalErr.slice(0, 400),
    });
    await ensurePendingQueueItem(supabase, {
      leadId,
      queueType: 'failed_automation',
      priorityLevel: 1,
      reason: `הפורטל החזיר ${portalResponse.status}`,
      queueSummary: portalErr.slice(0, 200),
      payloadJson: { correlationId, code, portalStatus: portalResponse.status },
    });
    return jsonResponse(req, { error: 'Portal rejected the invite', portalStatus: portalResponse.status }, 502);
  }

  const provisionedAt = new Date().toISOString();
  const { data: updatedRows, error: updErr } = await supabase
    .from('leads')
    .update({ portal_invite_code: code, portal_provisioned_at: provisionedAt })
    .eq('id', leadId)
    .is('portal_invite_code', null) // Race guard: only first writer wins.
    .select('id');

  if (updErr) {
    // Portal accepted the code but we couldn't persist on our side. The
    // operator needs to know — the invite is "live" but un-tracked here.
    log.error('lead_invite_persist_failed', {
      fn: 'provision-student', correlationId, leadId, err: updErr.message,
    });
    await ensurePendingQueueItem(supabase, {
      leadId,
      queueType: 'manual_review_required',
      priorityLevel: 1,
      reason: 'קוד נוצר בפורטל אבל לא נשמר ב-CRM — צריך תיוג ידני',
      payloadJson: { correlationId, code, provisionedAt },
    });
    return jsonResponse(req, { error: 'Persisted on portal but failed to save on lead' }, 500);
  }

  // Race loser: a concurrent call already persisted ITS code (0 rows
  // updated). Return the SAVED code — the one this call registered with
  // the portal is an orphan the CRM can't show, and handing it to the
  // operator would send the student a code the CRM doesn't know.
  if (!updatedRows || updatedRows.length === 0) {
    const { data: saved } = await supabase
      .from('leads')
      .select('portal_invite_code, portal_provisioned_at')
      .eq('id', leadId)
      .maybeSingle();
    log.info('portal_provision_race_lost', {
      fn: 'provision-student', correlationId, leadId, orphanCode: code,
      savedCode: saved?.portal_invite_code ?? null,
    });
    if (saved?.portal_invite_code) {
      return jsonResponse(req, {
        ok: true,
        code: saved.portal_invite_code,
        signupUrl: buildSignupLink(saved.portal_invite_code),
        provisionedAt: saved.portal_provisioned_at ?? provisionedAt,
        raceLost: true,
      });
    }
    // Shouldn't happen (guard only skips when a code exists) — surface it.
    return jsonResponse(req, { error: 'Invite persisted by a concurrent call but not found' }, 500);
  }

  await logLeadEvent(supabase, leadId, 'portal_invite_issued', 'system', {
    code,
    provisioned_at: provisionedAt,
    correlation_id: correlationId,
  });

  log.info('portal_provisioned', {
    fn: 'provision-student', correlationId, leadId, code,
  });

  return jsonResponse(req, {
    ok: true,
    code,
    signupUrl: buildSignupLink(code),
    provisionedAt,
  });
});
