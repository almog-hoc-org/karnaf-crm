// Manual lead CRUD for the operator console.
//
// Scope: data fields only (phone, email, full_name, source, source_detail,
// campaign_name, city, notes_internal). Lifecycle transitions
// (lead_status, ownership_mode, do_not_contact) keep flowing through
// admin-actions, which owns the state machine and event emission.
//
// All paths are JWT-gated and additionally require staff role
// (owner/admin/mia/sales_rep). Soft delete only — `removed_by_request=true`
// keeps the row + history intact for compliance.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { logLeadEvent, upsertLead } from '../_shared/lead-service.ts';
import { ensureProgramMember } from '../_shared/member-service.ts';
import { normalizeIsraeliPhone } from '../_shared/phone.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

const ALLOWED_SOURCES = new Set([
  'landing_page', 'webinar', 'responder_form', 'lead_magnet',
  'whatsapp_direct', 'instagram_dm', 'facebook_lead_ad',
  'manual_entry', 'screenshot_manual', 'unknown',
]);

const EDITABLE_DATA_FIELDS = new Set([
  'full_name', 'email', 'source', 'source_detail',
  'source_campaign', 'webinar_name', 'lead_magnet_name', 'city',
  'notes_internal',
]);

interface CreatePayload {
  action: 'create';
  phone?: string | null;
  email?: string | null;
  fullName?: string | null;
  source?: string;
  sourceDetail?: string | null;
  campaignName?: string | null;
  city?: string | null;
  notesInternal?: string | null;
}

interface UpdatePayload {
  action: 'update';
  leadId: string;
  /** Last-known updated_at for optimistic concurrency. If provided and the row has changed, we 409. */
  expectedUpdatedAt?: string;
  phone?: string | null;
  fullName?: string | null;
  email?: string | null;
  source?: string;
  sourceDetail?: string | null;
  campaignName?: string | null;
  webinarName?: string | null;
  leadMagnetName?: string | null;
  city?: string | null;
  notesInternal?: string | null;
}

interface DeletePayload {
  action: 'delete';
  leadId: string;
  reason?: string | null;
}

interface RestorePayload {
  action: 'restore';
  leadId: string;
}

interface PurgePayload {
  action: 'purge';
  leadId: string;
}

interface ImportRow {
  phone: string;
  fullName?: string | null;
  email?: string | null;
}

interface ImportPayload {
  action: 'import';
  rows: ImportRow[];
  markMember?: boolean;
  source?: string;
}

type Payload = CreatePayload | UpdatePayload | DeletePayload | RestorePayload | PurgePayload | ImportPayload;

const IMPORT_MAX_ROWS = 500;

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

  if (body.action === 'create') {
    if (!body.phone && !body.email) {
      return jsonResponse(req, { error: 'Either phone or email is required' }, 400);
    }

    const normalizedPhone = body.phone ? normalizeIsraeliPhone(body.phone) : null;
    if (body.phone && !normalizedPhone) {
      return jsonResponse(req, { error: 'Invalid Israeli phone number' }, 400);
    }

    const source = body.source ?? 'manual_entry';
    if (!ALLOWED_SOURCES.has(source)) {
      return jsonResponse(req, { error: `Invalid source: ${source}` }, 400);
    }

    try {
      const lead = await upsertLead(supabase, {
        phone: normalizedPhone,
        email: body.email ?? null,
        fullName: body.fullName ?? null,
        source,
        intakeChannel: 'manual_console',
        metadata: {
          source_detail: body.sourceDetail ?? null,
          source_campaign: body.campaignName ?? null,
          city: body.city ?? null,
          notes_internal: body.notesInternal ?? null,
          created_by_user_id: staff.userId,
          created_via: 'operator_console',
          correlation_id: correlationId,
        },
      });

      await logLeadEvent(supabase, lead.id, 'lead_manual_created', staff.role, {
        actor_user_id: staff.userId,
        source,
        correlation_id: correlationId,
      }, undefined, staff.userId);

      log.info('lead_manual_created', { fn: 'leads-manage', correlationId, by: staff.userId, leadId: lead.id });
      return jsonResponse(req, { ok: true, lead });
    } catch (err) {
      // PostgrestError serialises to "[object Object]" via String(); pull out
      // .message (and code/details/hint when present) so the operator UI shows
      // something actionable.
      const msg = err instanceof Error ? err.message
        : (err && typeof err === 'object' && 'message' in err) ? String((err as { message: unknown }).message)
        : (typeof err === 'object' ? JSON.stringify(err) : String(err));
      log.error('lead_create_failed', { fn: 'leads-manage', correlationId, err: msg, raw: err });
      return jsonResponse(req, { error: msg }, 500);
    }
  }

  if (body.action === 'update') {
    if (!body.leadId) return jsonResponse(req, { error: 'Missing leadId' }, 400);

    // Optimistic concurrency: refuse if the row was edited under our feet.
    // Compare timestamps as Date.getTime() so callers don't have to match the
    // exact textual format we read from Postgres.
    if (body.expectedUpdatedAt) {
      const { data: current, error: currErr } = await supabase
        .from('leads')
        .select('updated_at')
        .eq('id', body.leadId)
        .single();
      if (currErr) return jsonResponse(req, { error: currErr.message }, 500);
      if (current?.updated_at) {
        const expectedMs = Date.parse(body.expectedUpdatedAt);
        const actualMs = Date.parse(current.updated_at);
        if (Number.isFinite(expectedMs) && Number.isFinite(actualMs) && expectedMs !== actualMs) {
          return jsonResponse(req, {
            error: 'Lead was modified by another operator. Refresh and try again.',
            code: 'concurrent_modification',
          }, 409);
        }
      }
    }

    const updates: Record<string, unknown> = {};

    if (body.phone !== undefined) {
      if (body.phone === null || body.phone === '') {
        updates.phone = null;
      } else {
        const normalized = normalizeIsraeliPhone(body.phone);
        if (!normalized) return jsonResponse(req, { error: 'Invalid Israeli phone number' }, 400);
        updates.phone = normalized;
      }
    }

    const fieldMap: Record<string, string> = {
      fullName: 'full_name',
      email: 'email',
      source: 'source',
      sourceDetail: 'source_detail',
      campaignName: 'source_campaign',
      webinarName: 'webinar_name',
      leadMagnetName: 'lead_magnet_name',
      city: 'city',
      notesInternal: 'notes_internal',
    };
    for (const [camel, snake] of Object.entries(fieldMap)) {
      const v = (body as unknown as Record<string, unknown>)[camel];
      if (v !== undefined && EDITABLE_DATA_FIELDS.has(snake)) updates[snake] = v;
    }

    if (updates.source !== undefined && !ALLOWED_SOURCES.has(String(updates.source))) {
      return jsonResponse(req, { error: `Invalid source: ${updates.source}` }, 400);
    }

    if (Object.keys(updates).length === 0) {
      return jsonResponse(req, { error: 'No editable fields provided' }, 400);
    }

    const { data, error } = await supabase
      .from('leads')
      .update(updates)
      .eq('id', body.leadId)
      .select('*')
      .single();
    if (error) return jsonResponse(req, { error: error.message }, 500);

    await logLeadEvent(supabase, body.leadId, 'lead_manual_updated', staff.role, {
      actor_user_id: staff.userId,
      fields_changed: Object.keys(updates),
      correlation_id: correlationId,
    }, undefined, staff.userId);

    log.info('lead_manual_updated', {
      fn: 'leads-manage', correlationId, by: staff.userId, leadId: body.leadId,
      fields: Object.keys(updates),
    });
    return jsonResponse(req, { ok: true, lead: data });
  }

  if (body.action === 'restore') {
    // Owner/admin only — undo a soft-delete. do_not_contact is restored to
    // its PRE-delete value (recorded on the soft-delete event): the delete
    // forces it on, but a lead who had independently opted out before the
    // delete must not be re-enabled for outreach by a restore.
    if (staff.role !== 'owner' && staff.role !== 'admin') {
      return jsonResponse(req, { error: 'Restore requires owner/admin' }, 403);
    }
    if (!body.leadId) return jsonResponse(req, { error: 'Missing leadId' }, 400);

    const { data: deleteEvent } = await supabase
      .from('lead_events')
      .select('event_payload')
      .eq('lead_id', body.leadId)
      .eq('event_type', 'lead_manual_soft_deleted')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const priorDnc =
      (deleteEvent?.event_payload as { prior_do_not_contact?: boolean } | null)
        ?.prior_do_not_contact === true;

    const { data, error } = await supabase
      .from('leads')
      .update({ removed_by_request: false, do_not_contact: priorDnc })
      .eq('id', body.leadId)
      .select('id, removed_by_request, do_not_contact')
      .single();
    if (error) return jsonResponse(req, { error: error.message }, 500);

    await logLeadEvent(supabase, body.leadId, 'lead_manual_restored', staff.role, {
      actor_user_id: staff.userId,
      correlation_id: correlationId,
    }, undefined, staff.userId);

    log.info('lead_manual_restored', {
      fn: 'leads-manage', correlationId, by: staff.userId, leadId: body.leadId,
    });
    return jsonResponse(req, { ok: true, lead: data });
  }

  if (body.action === 'delete') {
    if (!body.leadId) return jsonResponse(req, { error: 'Missing leadId' }, 400);

    // Snapshot do_not_contact BEFORE forcing it on: restore must put the
    // flag back as it was, not blindly clear it — a lead who opted out
    // before the delete must stay opted-out after a restore.
    const { data: prior } = await supabase
      .from('leads')
      .select('do_not_contact')
      .eq('id', body.leadId)
      .maybeSingle();

    const { data, error } = await supabase
      .from('leads')
      .update({
        removed_by_request: true,
        do_not_contact: true,
      })
      .eq('id', body.leadId)
      .select('id, removed_by_request, do_not_contact')
      .single();
    if (error) return jsonResponse(req, { error: error.message }, 500);

    await logLeadEvent(supabase, body.leadId, 'lead_manual_soft_deleted', staff.role, {
      actor_user_id: staff.userId,
      reason: body.reason ?? null,
      prior_do_not_contact: prior?.do_not_contact ?? false,
      correlation_id: correlationId,
    }, undefined, staff.userId);

    log.info('lead_manual_soft_deleted', {
      fn: 'leads-manage', correlationId, by: staff.userId, leadId: body.leadId,
    });
    return jsonResponse(req, { ok: true, lead: data });
  }

  if (body.action === 'purge') {
    // Hard delete — permanently removes the lead and every dependent row
    // (messages, conversations, events, queue items) via FK cascades.
    // Unlike 'delete' (soft, restorable) and pii-delete (anonymises in
    // place), this frees the space entirely and cannot be undone.
    if (staff.role !== 'owner' && staff.role !== 'admin') {
      return jsonResponse(req, { error: 'Purge requires owner/admin' }, 403);
    }
    if (!body.leadId) return jsonResponse(req, { error: 'Missing leadId' }, 400);

    const { data: lead } = await supabase
      .from('leads')
      .select('id, full_name, phone, payment_status')
      .eq('id', body.leadId)
      .maybeSingle();
    if (!lead) return jsonResponse(req, { error: 'Lead not found' }, 404);

    // Refuse to purge paying customers from the UI path — losing their
    // history is almost never intended. Anonymise via pii-delete instead.
    if (lead.payment_status === 'paid') {
      return jsonResponse(req, { error: 'לא ניתן למחוק לצמיתות ליד ששילם — השתמשו במחיקת PII' }, 409);
    }

    const { error } = await supabase.from('leads').delete().eq('id', body.leadId);
    if (error) return jsonResponse(req, { error: error.message }, 500);

    log.info('lead_purged', {
      fn: 'leads-manage', correlationId, by: staff.userId, leadId: body.leadId,
    });
    return jsonResponse(req, { ok: true, purged: body.leadId });
  }

  if (body.action === 'import') {
    // Bulk list import (e.g. the program-member roster). Owner/admin only —
    // this can create hundreds of leads in one call.
    if (staff.role !== 'owner' && staff.role !== 'admin') {
      return jsonResponse(req, { error: 'Import requires owner/admin' }, 403);
    }
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length === 0) return jsonResponse(req, { error: 'No rows provided' }, 400);
    if (rows.length > IMPORT_MAX_ROWS) {
      return jsonResponse(req, { error: `Too many rows (max ${IMPORT_MAX_ROWS})` }, 400);
    }
    const source = body.source ?? 'manual_entry';
    if (!ALLOWED_SOURCES.has(source)) {
      return jsonResponse(req, { error: `Invalid source: ${source}` }, 400);
    }

    const results: Array<{ phone: string; leadId?: string; created?: boolean; memberCreated?: boolean; error?: string }> = [];
    for (const row of rows) {
      const rawPhone = typeof row?.phone === 'string' ? row.phone : '';
      const normalized = normalizeIsraeliPhone(rawPhone);
      if (!normalized) {
        results.push({ phone: rawPhone, error: 'invalid_phone' });
        continue;
      }
      try {
        const lead = await upsertLead(supabase, {
          phone: normalized,
          email: row.email ?? null,
          fullName: row.fullName ?? null,
          source,
          intakeChannel: 'manual_console',
          metadata: {
            created_by_user_id: staff.userId,
            created_via: 'operator_import',
            correlation_id: correlationId,
          },
        });
        let memberCreated = false;
        if (body.markMember) {
          const member = await ensureProgramMember(supabase, {
            leadId: lead.id,
            joinedVia: 'import',
            actorType: staff.role,
            actorId: staff.userId,
            correlationId,
          });
          memberCreated = member.created;
        }
        results.push({ phone: normalized, leadId: lead.id, memberCreated });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ phone: normalized, error: msg });
      }
    }

    const okCount = results.filter((r) => r.leadId).length;
    const failCount = results.length - okCount;
    // One summary log instead of a lead_event per row — a 500-row import
    // must not flood the activity feeds.
    await supabase.from('integration_logs').insert({
      source: 'operator_import',
      status: failCount === 0 ? 'success' : 'partial',
      request_data: {
        by: staff.userId,
        source,
        mark_member: body.markMember ?? false,
        total: results.length,
        ok: okCount,
        failed: failCount,
        correlation_id: correlationId,
      },
    });
    log.info('leads_import', {
      fn: 'leads-manage', correlationId, by: staff.userId,
      total: results.length, ok: okCount, failed: failCount,
    });
    return jsonResponse(req, { ok: true, total: results.length, okCount, failCount, results });
  }

  return jsonResponse(req, { error: 'Unsupported action' }, 400);
});
