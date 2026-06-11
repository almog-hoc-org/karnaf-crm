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
  action: 'close' | 'cancel' | 'mark_executed' | 'reopen' | 'publish';
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

  // Tier 4.D.8 — explicit "publish" action that fans the project out
  // to relevant leads via the engine. Separate from `create` so an
  // admin can fill in details first, then publish when ready.
  // Emits `project.recruiting` per (lead, project) pair so the B17
  // rule can match per-lead conditions. Capped at 500 leads per
  // publish to bound the work; if Karnaf ever has more "relevant"
  // leads this becomes a paginated background job.
  if (body.action === 'publish') {
    if (!body.id) return jsonResponse(req, { error: 'id required' }, 400);
    const { data: project, error: projErr } = await supabase
      .from('projects').select('*').eq('id', body.id).single();
    if (projErr || !project) {
      return jsonResponse(req, { error: projErr?.message ?? 'project not found' }, 404);
    }
    if (project.status !== 'recruiting') {
      return jsonResponse(req, { error: 'publish requires project status = recruiting' }, 400);
    }

    // "Relevant" = active leads in presale or contractor_group_purchase
    // interest who haven't opted out and aren't terminal.
    // Tier 7.B.1 — select the columns buildLeadContextFromRow expects.
    const { data: leads, error: leadsErr } = await supabase
      .from('leads')
      .select('id, full_name, phone, email, city, product_interest, intake_segment, primary_track, lead_status, ownership_mode, lead_heat, do_not_contact, removed_by_request, source, created_at, last_inbound_at, last_outbound_at')
      .eq('do_not_contact', false)
      .eq('removed_by_request', false)
      .not('lead_status', 'in', '(won,lost,suppressed)')
      .or('primary_track.eq.presale,product_interest.eq.contractor_group_purchase')
      .limit(500);
    if (leadsErr) return jsonResponse(req, { error: leadsErr.message }, 500);

    // Tier 7.B.1 — canonical lead context via shared builder. We
    // already selected the relevant lead columns; pass the row
    // straight through to avoid a per-lead re-query.
    const { runMatchingRules } = await import('../_shared/automation-engine.ts');
    const { buildLeadContextFromRow } = await import('../_shared/event-context.ts');
    let fired = 0;
    for (const lead of leads ?? []) {
      const leadCtx = await buildLeadContextFromRow(supabase, lead);
      await runMatchingRules(supabase, {
        triggerEvent: 'project.recruiting',
        context: {
          lead: leadCtx,
          project: {
            id: project.id, name: project.name, city: project.city,
            developer_name: project.developer_name, project_type: project.project_type,
            target_amount: project.target_amount, target_date: project.target_date,
            currency: project.currency,
          },
          // Top-level project_name so {{project_name}} works in template
          // bodies without `project.` prefix. Keeps spec template C14
          // ("פרויקט {{project_name}} ב{{city}}") direct.
          project_name: project.name,
          city: project.city,
        },
        contactId: lead.id,
        correlationId,
      });
      fired++;
    }
    log.info('project_published', { fn: 'projects', correlationId, by: staff.userId, id: project.id, fired });
    return jsonResponse(req, { ok: true, project, fired });
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
