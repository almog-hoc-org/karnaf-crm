// Operator-facing claim/release for live conversations.
//
// Flow:
//   1. Frontend POSTs { action: 'claim'|'release', conversationId, ttlMinutes? }
//   2. We require staff role (owner/admin/mia/sales_rep) and pull the
//      operator's profile id from the verified JWT.
//   3. Service role then calls the underlying SQL RPC.
//
// While an active (unreleased, unexpired) claim exists, orchestrate-message
// short-circuits the AI for that conversation. See migration 020.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { logLeadEvent } from '../_shared/lead-service.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

interface ClaimPayload {
  action: 'claim';
  conversationId: string;
  ttlMinutes?: number;
}

interface ReleasePayload {
  action: 'release';
  conversationId: string;
  reason?: string | null;
}

type Payload = ClaimPayload | ReleasePayload;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);

  let staff;
  try {
    staff = await requireStaff(req, { allow: ['owner', 'admin', 'mia', 'sales_rep'] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const supabase = getServiceSupabase();
  const body = (await req.json().catch(() => ({}))) as Payload;
  if (!body.conversationId) return jsonResponse(req, { error: 'Missing conversationId' }, 400);

  if (body.action === 'claim') {
    const ttl = Math.max(1, Math.min(240, Number(body.ttlMinutes ?? 30)));

    const { data, error } = await supabase.rpc('claim_conversation', {
      p_conversation_id: body.conversationId,
      p_operator_id: staff.userId,
      p_ttl_minutes: ttl,
    });

    if (error) {
      // Unique-violation = different operator already holds the claim.
      if (error.code === '23505' || /already claimed/i.test(error.message)) {
        return jsonResponse(req, { error: 'Conversation is already claimed by another operator', code: 'already_claimed' }, 409);
      }
      log.error('claim_failed', { fn: 'conversation-claims', correlationId, err: error.message });
      return jsonResponse(req, { error: error.message }, 500);
    }

    const row = Array.isArray(data) ? data[0] : data;

    // Best-effort lead-event audit (don't fail the claim on log failure).
    try {
      const { data: conv } = await supabase
        .from('conversations').select('lead_id').eq('id', body.conversationId).maybeSingle();
      if (conv?.lead_id) {
        await logLeadEvent(supabase, conv.lead_id, 'conversation_claimed_by_operator', staff.role, {
          conversation_id: body.conversationId,
          operator_id: staff.userId,
          expires_at: row?.expires_at ?? null,
          correlation_id: correlationId,
        }, body.conversationId, staff.userId);
      }
    } catch { /* swallow */ }

    log.info('claim_ok', {
      fn: 'conversation-claims', correlationId, by: staff.userId,
      conversationId: body.conversationId, ttl,
    });
    return jsonResponse(req, { ok: true, claim: row });
  }

  if (body.action === 'release') {
    const { data, error } = await supabase.rpc('release_conversation', {
      p_conversation_id: body.conversationId,
      p_operator_id: staff.userId,
      p_reason: body.reason ?? null,
    });
    if (error) {
      log.error('release_failed', { fn: 'conversation-claims', correlationId, err: error.message });
      return jsonResponse(req, { error: error.message }, 500);
    }

    const row = Array.isArray(data) ? data[0] : data;

    if (row) {
      try {
        const { data: conv } = await supabase
          .from('conversations').select('lead_id').eq('id', body.conversationId).maybeSingle();
        if (conv?.lead_id) {
          await logLeadEvent(supabase, conv.lead_id, 'conversation_released_by_operator', staff.role, {
            conversation_id: body.conversationId,
            operator_id: staff.userId,
            reason: body.reason ?? null,
            correlation_id: correlationId,
          }, body.conversationId, staff.userId);
        }
      } catch { /* swallow */ }
    }

    log.info('release_ok', {
      fn: 'conversation-claims', correlationId, by: staff.userId,
      conversationId: body.conversationId, hadActiveClaim: !!row,
    });
    return jsonResponse(req, { ok: true, claim: row ?? null });
  }

  return jsonResponse(req, { error: 'Unsupported action' }, 400);
});
