// Bulk lead operations endpoint. Wraps the bulk_* RPCs so the CRM manager
// can reassign owners or change heat for a selection from the leads list
// without paying N round-trips. Permission gating mirrors admin-actions.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

const MAX_BATCH_SIZE = 200;
const ALLOWED_HEATS = new Set(['hot', 'warm', 'cool', 'cold']);

interface BulkPayload {
  action: 'assign_owner' | 'change_heat' | 'snooze';
  leadIds: string[];
  assigneeUserId?: string;
  heat?: string;
  snoozeUntil?: string;
  note?: string | null;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);

  let staff;
  try {
    staff = await requireStaff(req, { allow: ['owner', 'admin', 'mia'] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as Partial<BulkPayload>;
  const action = body.action;
  const leadIds = Array.isArray(body.leadIds) ? body.leadIds.filter((s) => typeof s === 'string') : [];

  if (!action) return jsonResponse(req, { error: 'Missing action' }, 400);
  if (leadIds.length === 0) return jsonResponse(req, { error: 'No leads selected' }, 400);
  if (leadIds.length > MAX_BATCH_SIZE) {
    return jsonResponse(req, { error: `Batch too large (max ${MAX_BATCH_SIZE})` }, 400);
  }

  const supabase = getServiceSupabase();

  if (action === 'assign_owner') {
    if (!body.assigneeUserId) return jsonResponse(req, { error: 'Missing assigneeUserId' }, 400);
    // Validate that the assignee is an active staff user before fanning out
    // the update; service-role can otherwise write to any uuid.
    const { data: assignee, error: assigneeErr } = await supabase
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', body.assigneeUserId)
      .maybeSingle();
    if (assigneeErr) return jsonResponse(req, { error: assigneeErr.message }, 500);
    if (!assignee || !assignee.is_active) {
      return jsonResponse(req, { error: 'Assignee is not an active user' }, 400);
    }
    if (!['owner', 'admin', 'mia', 'sales_rep'].includes(assignee.role)) {
      return jsonResponse(req, { error: 'Assignee role cannot own leads' }, 400);
    }

    const { data, error } = await supabase.rpc('bulk_assign_lead_owner', {
      p_lead_ids: leadIds,
      p_assignee_user_id: body.assigneeUserId,
      p_actor_role: staff.role,
      p_actor_id: staff.userId,
      p_correlation_id: correlationId,
    });
    if (error) return jsonResponse(req, { error: error.message }, 500);
    const updated = Array.isArray(data) ? (data[0]?.updated_count ?? 0) : 0;
    log.info('bulk_assign_owner', {
      fn: 'bulk-lead-actions', correlationId, by: staff.userId,
      assignee: body.assigneeUserId, count: updated,
    });
    return jsonResponse(req, { ok: true, updated });
  }

  if (action === 'change_heat') {
    if (!body.heat || !ALLOWED_HEATS.has(body.heat)) {
      return jsonResponse(req, { error: 'Invalid heat' }, 400);
    }
    const { data, error } = await supabase.rpc('bulk_change_lead_heat', {
      p_lead_ids: leadIds,
      p_heat: body.heat,
      p_actor_role: staff.role,
      p_actor_id: staff.userId,
      p_correlation_id: correlationId,
    });
    if (error) return jsonResponse(req, { error: error.message }, 500);
    const updated = Array.isArray(data) ? (data[0]?.updated_count ?? 0) : 0;
    log.info('bulk_change_heat', {
      fn: 'bulk-lead-actions', correlationId, by: staff.userId,
      heat: body.heat, count: updated,
    });
    return jsonResponse(req, { ok: true, updated });
  }

  if (action === 'snooze') {
    const untilMs = Date.parse(body.snoozeUntil ?? '');
    if (!Number.isFinite(untilMs) || untilMs <= Date.now()) {
      return jsonResponse(req, { error: 'snoozeUntil חייב להיות תאריך עתידי' }, 400);
    }
    if (untilMs > Date.now() + 180 * 24 * 3600 * 1000) {
      return jsonResponse(req, { error: 'השהיה מוגבלת ל-180 יום' }, 400);
    }
    const nowIso = new Date().toISOString();
    const untilIso = new Date(untilMs).toISOString();
    const cleanNote = body.note ? String(body.note).trim().slice(0, 280) || null : null;
    const { data: updatedRows, error } = await supabase
      .from('leads')
      .update({
        snoozed_until: untilIso,
        snoozed_at: nowIso,
        snooze_note: cleanNote,
        triage_cleared_at: nowIso,
      })
      .in('id', leadIds)
      .select('id');
    if (error) return jsonResponse(req, { error: error.message }, 500);
    const ids = (updatedRows ?? []).map((r) => r.id as string);
    if (ids.length) {
      await supabase.from('lead_events').insert(ids.map((id) => ({
        lead_id: id,
        event_type: 'lead_snoozed',
        actor_type: staff.role,
        event_payload: {
          actor_user_id: staff.userId,
          snoozed_until: untilIso,
          note: cleanNote,
          bulk: true,
          correlation_id: correlationId,
        },
      })));
    }
    log.info('bulk_snooze', {
      fn: 'bulk-lead-actions', correlationId, by: staff.userId, count: ids.length, until: untilIso,
    });
    return jsonResponse(req, { ok: true, updated: ids.length });
  }

  return jsonResponse(req, { error: 'Unsupported action' }, 400);
});
