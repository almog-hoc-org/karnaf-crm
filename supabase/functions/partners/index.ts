// CRUD for the partners registry — freelancers and external service
// providers who close on behalf of Karnaf (spec § ד5). Owner/admin/mia
// can list and edit; partners themselves can read their own row via
// the self_read RLS policy from migration 058 (eventually used by a
// partner-portal flow we haven't built yet).
//
// GET   → list partners + their workload counts in one call so the
//         "assign to least-loaded partner" UI doesn't need a second
//         round-trip.
// POST  → create | update | archive | restore (action in body).

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

interface CreatePayload {
  action: 'create';
  full_name: string;
  phone?: string | null;
  email?: string | null;
  domain: 'investor_mentorship' | 'appraisal' | 'legal' | 'financing' | 'other';
  commission_to_karnaf_pct?: number;
  notes?: string | null;
}
interface UpdatePayload {
  action: 'update';
  id: string;
  full_name?: string;
  phone?: string | null;
  email?: string | null;
  domain?: 'investor_mentorship' | 'appraisal' | 'legal' | 'financing' | 'other';
  commission_to_karnaf_pct?: number;
  notes?: string | null;
}
interface StatusPayload {
  action: 'archive' | 'restore' | 'pause';
  id: string;
}
type Payload = CreatePayload | UpdatePayload | StatusPayload;

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
    // Join partners with the workload view so the UI can render
    // "open deals" per partner without a follow-up call.
    const [partnersRes, workloadRes] = await Promise.all([
      supabase.from('partners').select('*').order('status').order('full_name'),
      supabase.from('partner_workload').select('*'),
    ]);
    if (partnersRes.error) return jsonResponse(req, { error: partnersRes.error.message }, 500);
    if (workloadRes.error) return jsonResponse(req, { error: workloadRes.error.message }, 500);
    return jsonResponse(req, {
      ok: true,
      partners: partnersRes.data ?? [],
      workload: workloadRes.data ?? [],
    });
  }

  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const body = (await req.json().catch(() => ({}))) as Payload;

  if (body.action === 'create') {
    if (!body.full_name || body.full_name.trim().length === 0) {
      return jsonResponse(req, { error: 'full_name required' }, 400);
    }
    if (!body.domain) {
      return jsonResponse(req, { error: 'domain required' }, 400);
    }
    const pct = body.commission_to_karnaf_pct ?? 0;
    if (pct < 0 || pct > 100) {
      return jsonResponse(req, { error: 'commission_to_karnaf_pct must be 0..100' }, 400);
    }
    const { data, error } = await supabase
      .from('partners')
      .insert({
        full_name: body.full_name.trim(),
        phone: body.phone?.trim() || null,
        email: body.email?.trim().toLowerCase() || null,
        domain: body.domain,
        commission_to_karnaf_pct: pct,
        notes: body.notes?.trim() || null,
      })
      .select('*')
      .single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('partner_created', { fn: 'partners', correlationId, by: staff.userId, id: data.id });
    return jsonResponse(req, { ok: true, partner: data });
  }

  if (body.action === 'update') {
    if (!body.id) return jsonResponse(req, { error: 'id required' }, 400);
    const patch: Record<string, unknown> = {};
    if (body.full_name !== undefined) patch.full_name = body.full_name.trim();
    if (body.phone !== undefined) patch.phone = body.phone?.trim() || null;
    if (body.email !== undefined) patch.email = body.email?.trim().toLowerCase() || null;
    if (body.domain !== undefined) patch.domain = body.domain;
    if (body.commission_to_karnaf_pct !== undefined) {
      if (body.commission_to_karnaf_pct < 0 || body.commission_to_karnaf_pct > 100) {
        return jsonResponse(req, { error: 'commission_to_karnaf_pct must be 0..100' }, 400);
      }
      patch.commission_to_karnaf_pct = body.commission_to_karnaf_pct;
    }
    if (body.notes !== undefined) patch.notes = body.notes?.trim() || null;
    if (Object.keys(patch).length === 0) {
      return jsonResponse(req, { error: 'no fields to update' }, 400);
    }
    const { data, error } = await supabase
      .from('partners')
      .update(patch)
      .eq('id', body.id)
      .select('*')
      .single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('partner_updated', { fn: 'partners', correlationId, by: staff.userId, id: body.id });
    return jsonResponse(req, { ok: true, partner: data });
  }

  if (body.action === 'archive' || body.action === 'restore' || body.action === 'pause') {
    if (!body.id) return jsonResponse(req, { error: 'id required' }, 400);
    const status = body.action === 'archive' ? 'archived' : body.action === 'pause' ? 'paused' : 'active';
    const { data, error } = await supabase
      .from('partners').update({ status }).eq('id', body.id).select('*').single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('partner_status_changed', { fn: 'partners', correlationId, by: staff.userId, id: body.id, status });
    return jsonResponse(req, { ok: true, partner: data });
  }

  return jsonResponse(req, { error: 'Unknown action' }, 400);
});
