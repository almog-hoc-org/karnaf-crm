// Commissions API — list + manual state transitions.
//
// The pending → to_bill transition is automatic (DB trigger fires off
// deals.contract_signed_at). The to_bill → paid transition needs the
// operator: someone has to know money actually hit the account.
//
// GET   → list with joined partner/deal context for the operator UI.
// POST  → mark_paid (with optional amount + method) | cancel.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

interface MarkPaidPayload {
  action: 'mark_paid';
  id: string;
  amount_received?: number;
  payment_method?: string;
  payment_reference?: string;
  notes?: string;
}
interface CancelPayload {
  action: 'cancel';
  id: string;
  cancellation_reason: string;
}
type Payload = MarkPaidPayload | CancelPayload;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const correlationId = correlationFromRequest(req);
  let staff;
  try {
    staff = await requireStaff(req, { allow: ['owner', 'admin', 'mia'] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const supabase = getServiceSupabase();

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const statusFilter = url.searchParams.get('status'); // pending|to_bill|paid|cancelled or null=all
    let query = supabase
      .from('commissions')
      .select('*, partners!inner(id, full_name, domain), deals!inner(id, track, value, status)')
      .order('status')
      .order('to_bill_at', { ascending: true, nullsFirst: false })
      .order('pending_at', { ascending: false });
    if (statusFilter) query = query.eq('status', statusFilter);
    const { data, error } = await query;
    if (error) return jsonResponse(req, { error: error.message }, 500);
    return jsonResponse(req, { ok: true, commissions: data ?? [] });
  }

  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const body = (await req.json().catch(() => ({}))) as Payload;
  if (!body.id) return jsonResponse(req, { error: 'id required' }, 400);

  const current = await supabase.from('commissions').select('status, amount_due, currency').eq('id', body.id).single();
  if (current.error) return jsonResponse(req, { error: current.error.message }, 404);

  if (body.action === 'mark_paid') {
    if (current.data?.status !== 'to_bill') {
      return jsonResponse(req, { error: `cannot mark_paid from status ${current.data?.status}` }, 400);
    }
    const amount = body.amount_received ?? current.data.amount_due;
    if (amount < 0) {
      return jsonResponse(req, { error: 'amount_received must be non-negative' }, 400);
    }
    const { data, error } = await supabase
      .from('commissions')
      .update({
        status: 'paid',
        paid_at: new Date().toISOString(),
        amount_received: amount,
        payment_method: body.payment_method ?? null,
        payment_reference: body.payment_reference ?? null,
        notes: body.notes ?? null,
      })
      .eq('id', body.id)
      .select('*')
      .single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('commission_paid', { fn: 'commissions', correlationId, by: staff.userId, id: body.id, amount });
    return jsonResponse(req, { ok: true, commission: data });
  }

  if (body.action === 'cancel') {
    if (current.data?.status === 'paid' || current.data?.status === 'cancelled') {
      return jsonResponse(req, { error: `cannot cancel from status ${current.data?.status}` }, 400);
    }
    if (!body.cancellation_reason || body.cancellation_reason.trim().length === 0) {
      return jsonResponse(req, { error: 'cancellation_reason required' }, 400);
    }
    const { data, error } = await supabase
      .from('commissions')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancellation_reason: body.cancellation_reason.trim(),
      })
      .eq('id', body.id)
      .select('*')
      .single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('commission_cancelled', { fn: 'commissions', correlationId, by: staff.userId, id: body.id });
    return jsonResponse(req, { ok: true, commission: data });
  }

  return jsonResponse(req, { error: 'Unknown action' }, 400);
});
