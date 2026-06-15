// Operator feedback on AI decisions.
//
// Frontend POSTs { decisionId, rating: -1|0|1, correctionText? } here.
// We require staff role; the operator's profile id comes from the verified
// JWT (never trusted from the body). Rating UPSERTs by (decision_id,
// operator_id) — so toggling 👍 → 👎 just flips the row, no duplicates.
//
// Aggregation lives in nightly-jobs via v_prompt_variant_review_stats.
// This endpoint only writes the raw rating.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

interface ReviewPayload {
  decisionId: string;
  rating: -1 | 0 | 1;
  correctionText?: string | null;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const correlationId = correlationFromRequest(req);

  let staff;
  try {
    staff = await requireStaff(req, { allow: ['owner', 'admin', 'mia', 'sales_rep'] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const supabase = getServiceSupabase();

  if (req.method === 'GET') {
    // Useful for the LeadDetailPage initial paint: which messages already
    // got a rating from this operator? Saves a per-message round-trip.
    const url = new URL(req.url);
    const leadId = url.searchParams.get('leadId');
    if (!leadId) return jsonResponse(req, { error: 'Missing leadId' }, 400);
    const { data, error } = await supabase
      .from('ai_decision_reviews')
      .select('decision_id, rating, correction_text, created_at, operator_id, ai_decisions!inner(lead_id)')
      .eq('operator_id', staff.userId)
      .eq('ai_decisions.lead_id', leadId);
    if (error) return jsonResponse(req, { error: error.message }, 500);
    return jsonResponse(req, { ok: true, reviews: data ?? [] });
  }

  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const body = (await req.json().catch(() => ({}))) as ReviewPayload;
  if (!body.decisionId) return jsonResponse(req, { error: 'Missing decisionId' }, 400);
  if (![-1, 0, 1].includes(body.rating)) {
    return jsonResponse(req, { error: 'rating must be -1, 0, or 1' }, 400);
  }

  // Use the unique index (decision_id, operator_id) for upsert — toggling
  // a thumbs-up to thumbs-down by the same operator overwrites instead of
  // inserting twice.
  const { data, error } = await supabase
    .from('ai_decision_reviews')
    .upsert({
      decision_id: body.decisionId,
      operator_id: staff.userId,
      rating: body.rating,
      correction_text: body.correctionText ?? null,
    }, { onConflict: 'decision_id,operator_id' })
    .select('id, decision_id, rating, correction_text, created_at')
    .single();
  if (error) return jsonResponse(req, { error: error.message }, 500);

  log.info('ai_decision_reviewed', {
    fn: 'ai-review', correlationId,
    by: staff.userId, decisionId: body.decisionId, rating: body.rating,
  });
  return jsonResponse(req, { ok: true, review: data });
});
