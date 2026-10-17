// GDPR-style erasure of ONE lead: marks it removed_by_request + do_not_contact
// and anonymises the lead row and its messages right away (purge_lead_pii,
// migration 137). It used to call purge_removed_pii(-1), which anonymised
// every soft-deleted lead in the table, not just the one requested.
//
// Auth: owner / admin only. Requires a confirmation token derived from
// the lead's current updated_at to prevent accidental wipes.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

interface DeleteInput {
  leadId: string;
  reason: string;
  confirmUpdatedAt: string;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);
  let staff;
  try {
    staff = await requireStaff(req, { allow: ['owner', 'admin'] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const body = await req.json().catch(() => ({})) as Partial<DeleteInput>;
  if (!body.leadId || !body.reason || !body.confirmUpdatedAt) {
    return jsonResponse(req, { error: 'leadId, reason, confirmUpdatedAt required' }, 400);
  }
  if (body.reason.trim().length < 5) {
    return jsonResponse(req, { error: 'Reason must be at least 5 chars (audit trail)' }, 400);
  }

  const supabase = getServiceSupabase();
  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('id, updated_at, removed_by_request')
    .eq('id', body.leadId)
    .single();
  if (leadErr || !lead) return jsonResponse(req, { error: leadErr?.message ?? 'Lead not found' }, 404);

  const expected = Date.parse(body.confirmUpdatedAt);
  const actual = Date.parse(String(lead.updated_at));
  if (Number.isFinite(expected) && Number.isFinite(actual) && expected !== actual) {
    return jsonResponse(req, {
      error: 'Lead changed since confirmation — refresh and re-confirm.',
      code: 'stale_confirm_token',
    }, 409);
  }

  const { error: markErr } = await supabase
    .from('leads')
    .update({ removed_by_request: true, do_not_contact: true })
    .eq('id', body.leadId);
  if (markErr) return jsonResponse(req, { error: markErr.message }, 500);

  const { data: purged, error: purgeErr } = await supabase.rpc('purge_lead_pii', { p_lead_id: body.leadId });
  if (purgeErr || purged !== true) {
    log.warn('pii_purge_rpc_failed', {
      fn: 'pii-delete', correlationId, err: purgeErr?.message ?? 'lead not found by purge_lead_pii',
    });
  }

  await supabase.from('integration_logs').insert({
    source: 'pii_delete',
    status: 'success',
    lead_id: body.leadId,
    request_data: { deleted_by: staff.userId, reason: body.reason },
    response_data: { purge_ok: !purgeErr && purged === true },
  });

  log.info('pii_deleted', { fn: 'pii-delete', correlationId, by: staff.userId, leadId: body.leadId });

  const purgedNow = !purgeErr && purged === true;
  return jsonResponse(req, {
    ok: true,
    leadId: body.leadId,
    purgedImmediately: purgedNow,
    note: purgedNow ? 'lead anonymised' : 'lead marked removed; nightly purge will anonymise',
  });
});
