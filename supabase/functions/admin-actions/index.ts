import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensurePendingQueueItem, resolveQueueItem } from '../_shared/queue-service.ts';
import { logLeadEvent, transitionLeadStatus, updateLeadFields } from '../_shared/lead-service.ts';
import { AuthError, requireStaff, type StaffRole } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

type ActionName =
  | 'assign_to_mia'
  | 'return_to_ai'
  | 'mark_phone_escalation'
  | 'mark_dnc'
  | 'mark_lost'
  | 'mark_won'
  | 'reopen_lead'
  | 'resolve_queue'
  | 'log_phone_call'
  | 'update_lead_meta';

const REOPEN_TARGETS = new Set(['responded', 'qualified', 'nurture', 'human_handoff']);

// Per-action role allowlist. Sales reps can only log their own calls and
// resolve queue items; lifecycle transitions (won/lost/dnc/handoff) and
// ownership re-routing belong to Mia / admins / owners.
const ACTION_ROLES: Record<ActionName, StaffRole[]> = {
  assign_to_mia: ['owner', 'admin', 'mia'],
  return_to_ai: ['owner', 'admin', 'mia'],
  mark_phone_escalation: ['owner', 'admin', 'mia'],
  mark_dnc: ['owner', 'admin', 'mia'],
  mark_lost: ['owner', 'admin', 'mia'],
  mark_won: ['owner', 'admin', 'mia'],
  reopen_lead: ['owner', 'admin'],
  resolve_queue: ['owner', 'admin', 'mia', 'sales_rep'],
  log_phone_call: ['owner', 'admin', 'mia', 'sales_rep'],
  update_lead_meta: ['owner', 'admin', 'mia'],
};

interface ActionPayload {
  action: ActionName;
  leadId?: string;
  conversationId?: string | null;
  queueItemId?: string;
  note?: string | null;
  targetStatus?: string;
  callOutcome?: 'connected' | 'no_answer' | 'voicemail' | 'declined' | 'callback_requested';
  callDurationMinutes?: number;
  metaUpdates?: {
    goal_summary?: string | null;
    pain_point_summary?: string | null;
    main_blocker?: string | null;
    next_action_type?: string | null;
  };
}

const META_ALLOWED_FIELDS = new Set(['goal_summary', 'pain_point_summary', 'main_blocker', 'next_action_type']);
const META_MAX_LENGTH = 280;

function sanitiseMetaUpdates(input: ActionPayload['metaUpdates']): Record<string, string | null> | null {
  if (!input || typeof input !== 'object') return null;
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!META_ALLOWED_FIELDS.has(k)) continue;
    if (v === null) {
      out[k] = null;
    } else if (typeof v === 'string') {
      const trimmed = v.trim().slice(0, META_MAX_LENGTH);
      out[k] = trimmed.length === 0 ? null : trimmed;
    }
  }
  return Object.keys(out).length ? out : null;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const correlationId = correlationFromRequest(req);

  let staff;
  try {
    // Allow any staff role through the door; per-action gating runs below
    // once we know which action was requested.
    staff = await requireStaff(req, { allow: ['owner', 'admin', 'mia', 'sales_rep'] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const body = await req.json().catch(() => ({})) as ActionPayload;
  const { action, leadId, conversationId, queueItemId, note, targetStatus, callOutcome, callDurationMinutes } = body;

  if (!action) return jsonResponse(req, { error: 'Missing action' }, 400);

  const allowedRoles = ACTION_ROLES[action];
  if (!allowedRoles) return jsonResponse(req, { error: 'Unsupported action' }, 400);
  if (!allowedRoles.includes(staff.role)) {
    return jsonResponse(req, { error: `Role '${staff.role}' not permitted for action '${action}'` }, 403);
  }

  const supabase = getServiceSupabase();

  if (action === 'resolve_queue') {
    if (!queueItemId) return jsonResponse(req, { error: 'Missing queueItemId' }, 400);
    await resolveQueueItem(supabase, queueItemId, note ?? null);
    log.info('admin_action', { fn: 'admin-actions', correlationId, userId: staff.userId, action });
    return jsonResponse(req, { ok: true, action });
  }

  if (!leadId) return jsonResponse(req, { error: 'Missing leadId' }, 400);

  const meta = { actor_user_id: staff.userId, role: staff.role, note: note ?? null, correlation_id: correlationId };
  const ts = new Date().toISOString();

  switch (action) {
    case 'assign_to_mia': {
      await updateLeadFields(supabase, leadId, {
        ownership_mode: 'mia_active',
        human_owner_id: staff.userId,
        last_human_touch_at: ts,
      });
      await transitionLeadStatus(supabase, leadId, 'human_handoff', staff.role, 'manual_assign_to_mia');
      await ensurePendingQueueItem(supabase, {
        leadId, queueType: 'human_handoff', priorityLevel: 2,
        reason: note ?? 'Assigned to Mia manually',
        queueSummary: note ?? 'Manual assignment to Mia',
        payloadJson: meta,
        createdByActorType: staff.role,
      });
      await logLeadEvent(supabase, leadId, 'manual_assign_to_mia', staff.role, meta, conversationId ?? undefined, staff.userId);
      break;
    }
    case 'return_to_ai': {
      await updateLeadFields(supabase, leadId, { ownership_mode: 'ai_active' });
      // If we left the lead parked in human_handoff during Mia's takeover,
      // move it back to a status the AI playbook router actually handles —
      // otherwise the orchestrator falls into qualification with stale
      // context and may decide to stay silent.
      const { data: currentLead } = await supabase
        .from('leads').select('lead_status').eq('id', leadId).maybeSingle();
      if (currentLead?.lead_status === 'human_handoff') {
        await transitionLeadStatus(supabase, leadId, 'responded', staff.role, 'manual_return_to_ai');
      }
      await logLeadEvent(supabase, leadId, 'manual_return_to_ai', staff.role, meta, conversationId ?? undefined, staff.userId);
      break;
    }
    case 'mark_phone_escalation': {
      await updateLeadFields(supabase, leadId, {
        ownership_mode: 'phone_sales_pending',
        requested_phone_call: true,
        last_human_touch_at: ts,
      });
      await ensurePendingQueueItem(supabase, {
        leadId, queueType: 'phone_escalation', priorityLevel: 1,
        reason: note ?? 'Phone escalation requested',
        queueSummary: note ?? null,
        payloadJson: meta,
        createdByActorType: staff.role,
      });
      await logLeadEvent(supabase, leadId, 'manual_phone_escalation', staff.role, meta, conversationId ?? undefined, staff.userId);
      break;
    }
    case 'mark_dnc': {
      await updateLeadFields(supabase, leadId, { do_not_contact: true });
      await transitionLeadStatus(supabase, leadId, 'do_not_contact', staff.role, 'manual_mark_dnc');
      await logLeadEvent(supabase, leadId, 'manual_mark_dnc', staff.role, meta, conversationId ?? undefined, staff.userId);
      break;
    }
    case 'mark_lost': {
      await updateLeadFields(supabase, leadId, { lost_at: ts, lost_reason: note ?? null });
      await transitionLeadStatus(supabase, leadId, 'lost', staff.role, 'manual_mark_lost');
      await logLeadEvent(supabase, leadId, 'manual_mark_lost', staff.role, meta, conversationId ?? undefined, staff.userId);
      break;
    }
    case 'mark_won': {
      await updateLeadFields(supabase, leadId, { won_at: ts });
      await transitionLeadStatus(supabase, leadId, 'won', staff.role, 'manual_mark_won');
      await logLeadEvent(supabase, leadId, 'manual_mark_won', staff.role, meta, conversationId ?? undefined, staff.userId);
      break;
    }
    case 'reopen_lead': {
      if (!targetStatus || !REOPEN_TARGETS.has(targetStatus)) {
        return jsonResponse(req, { error: 'Invalid targetStatus for reopen_lead' }, 400);
      }
      const { error: reopenErr } = await supabase.rpc('reopen_lead', {
        p_lead_id: leadId,
        p_target_status: targetStatus,
        p_actor_role: staff.role,
        p_reason: note ?? null,
        p_actor_user_id: staff.userId,
      });
      if (reopenErr) {
        log.warn('reopen_lead_failed', { fn: 'admin-actions', correlationId, leadId, err: reopenErr.message });
        return jsonResponse(req, { error: reopenErr.message }, 400);
      }
      // RPC inserts its own lead_events rows (lead_reopened + lead_status_changed).
      break;
    }
    case 'update_lead_meta': {
      const sanitised = sanitiseMetaUpdates(body.metaUpdates);
      if (!sanitised) return jsonResponse(req, { error: 'No meta fields to update' }, 400);
      await updateLeadFields(supabase, leadId, sanitised);
      await logLeadEvent(
        supabase,
        leadId,
        'lead_meta_updated',
        staff.role,
        { ...meta, updates: sanitised },
        conversationId ?? undefined,
        staff.userId,
      );
      break;
    }
    case 'log_phone_call': {
      const callMeta = { ...meta, outcome: callOutcome ?? 'connected', duration_minutes: callDurationMinutes ?? null };
      await supabase.from('lead_tasks').insert({
        lead_id: leadId,
        task_type: 'phone_call_logged',
        task_status: 'done',
        owner_type: staff.role === 'sales_rep' ? 'sales_rep' : staff.role,
        owner_user_id: staff.userId,
        title: `שיחת טלפון: ${callOutcome ?? 'connected'}`,
        description: note ?? null,
        priority_level: 3,
        completed_at: ts,
        completion_note: note ?? null,
        payload_json: callMeta,
      });
      await updateLeadFields(supabase, leadId, { last_human_touch_at: ts });
      await logLeadEvent(supabase, leadId, 'phone_call_logged', staff.role, callMeta, conversationId ?? undefined, staff.userId);
      break;
    }
    default:
      return jsonResponse(req, { error: 'Unsupported action' }, 400);
  }

  log.info('admin_action', { fn: 'admin-actions', correlationId, userId: staff.userId, action, leadId });
  return jsonResponse(req, { ok: true, action });
});
