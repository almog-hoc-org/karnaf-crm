// CRUD for the projects registry — presale (קבוצת רכישה) projects
// each holding many investor deals. Spec § ד6. Owner/admin/mia only.
//
// GET   → list projects + their funding progress in one call.
// POST  → create | update | close | cancel | mark_executed (action).
//
// Status state machine (enforced application-side in the action
// dispatcher below, plus the DB CHECK on projects.status):
//   recruiting → closed | cancelled
//   closed → executed | cancelled
//   executed → (terminal)
//   cancelled → (terminal)

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

interface CreatePayload {
  action: 'create';
  name: string;
  city?: string | null;
  developer_name?: string | null;
  project_type?: 'residential' | 'commercial' | 'mixed';
  total_units?: number | null;
  price_per_unit?: number | null;
  target_amount?: number | null;
  target_date?: string | null;
  notes?: string | null;
}
interface UpdatePayload {
  action: 'update';
  id: string;
  name?: string;
  city?: string | null;
  developer_name?: string | null;
  project_type?: 'residential' | 'commercial' | 'mixed';
  total_units?: number | null;
  price_per_unit?: number | null;
  target_amount?: number | null;
  target_date?: string | null;
  notes?: string | null;
}
interface StatusPayload {
  action: 'close' | 'cancel' | 'mark_executed' | 'reopen';
  id: string;
}
type Payload = CreatePayload | UpdatePayload | StatusPayload;

const NEXT_STATUS: Record<string, Record<string, string>> = {
  recruiting: { close: 'closed', cancel: 'cancelled' },
  closed: { mark_executed: 'executed', cancel: 'cancelled', reopen: 'recruiting' },
  executed: {},
  cancelled: { reopen: 'recruiting' },
};

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
    const [projectsRes, fundingRes] = await Promise.all([
      supabase.from('projects').select('*').order('status').order('name'),
      supabase.from('project_funding_progress').select('*'),
    ]);
    if (projectsRes.error) return jsonResponse(req, { error: projectsRes.error.message }, 500);
    if (fundingRes.error) return jsonResponse(req, { error: fundingRes.error.message }, 500);
    return jsonResponse(req, {
      ok: true,
      projects: projectsRes.data ?? [],
      funding: fundingRes.data ?? [],
    });
  }

  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const body = (await req.json().catch(() => ({}))) as Payload;

  if (body.action === 'create') {
    if (!body.name || body.name.trim().length === 0) {
      return jsonResponse(req, { error: 'name required' }, 400);
    }
    const { data, error } = await supabase
      .from('projects')
      .insert({
        name: body.name.trim(),
        city: body.city?.trim() || null,
        developer_name: body.developer_name?.trim() || null,
        project_type: body.project_type ?? 'residential',
        total_units: body.total_units ?? null,
        price_per_unit: body.price_per_unit ?? null,
        target_amount: body.target_amount ?? null,
        target_date: body.target_date ?? null,
        notes: body.notes?.trim() || null,
      })
      .select('*')
      .single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('project_created', { fn: 'projects', correlationId, by: staff.userId, id: data.id });
    return jsonResponse(req, { ok: true, project: data });
  }

  if (body.action === 'update') {
    if (!body.id) return jsonResponse(req, { error: 'id required' }, 400);
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.city !== undefined) patch.city = body.city?.trim() || null;
    if (body.developer_name !== undefined) patch.developer_name = body.developer_name?.trim() || null;
    if (body.project_type !== undefined) patch.project_type = body.project_type;
    if (body.total_units !== undefined) patch.total_units = body.total_units;
    if (body.price_per_unit !== undefined) patch.price_per_unit = body.price_per_unit;
    if (body.target_amount !== undefined) patch.target_amount = body.target_amount;
    if (body.target_date !== undefined) patch.target_date = body.target_date;
    if (body.notes !== undefined) patch.notes = body.notes?.trim() || null;
    if (Object.keys(patch).length === 0) {
      return jsonResponse(req, { error: 'no fields to update' }, 400);
    }
    const { data, error } = await supabase
      .from('projects').update(patch).eq('id', body.id).select('*').single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('project_updated', { fn: 'projects', correlationId, by: staff.userId, id: body.id });
    return jsonResponse(req, { ok: true, project: data });
  }

  if (['close', 'cancel', 'mark_executed', 'reopen'].includes(body.action)) {
    if (!body.id) return jsonResponse(req, { error: 'id required' }, 400);
    const current = await supabase.from('projects').select('status').eq('id', body.id).single();
    if (current.error) return jsonResponse(req, { error: current.error.message }, 404);
    const fromStatus = current.data?.status as string;
    const toStatus = NEXT_STATUS[fromStatus]?.[body.action];
    if (!toStatus) {
      return jsonResponse(req, { error: `cannot ${body.action} from status ${fromStatus}` }, 400);
    }
    const { data, error } = await supabase
      .from('projects').update({ status: toStatus }).eq('id', body.id).select('*').single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('project_status_changed', {
      fn: 'projects', correlationId, by: staff.userId, id: body.id, from: fromStatus, to: toStatus,
    });
    return jsonResponse(req, { ok: true, project: data });
  }

  return jsonResponse(req, { error: 'Unknown action' }, 400);
});
