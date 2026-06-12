import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensurePendingQueueItem, resolveQueueItem } from '../_shared/queue-service.ts';
import { logLeadEvent, transitionLeadStatus, updateLeadFields } from '../_shared/lead-service.ts';
import { AuthError, requireStaff, type StaffRole } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { env } from '../_shared/env.ts';
import { runMatchingRules } from '../_shared/automation-engine.ts';
import { buildLeadContext } from '../_shared/event-context.ts';

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
  | 'schedule_meeting'
  | 'update_meeting_status'
  | 'advance_deal_stage'
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
  // Reopening a closed (won/lost) lead is an audited override. Per product
  // call, restricted to owner/admin — Mia escalates to them rather than
  // ping-ponging closed states on her own.
  reopen_lead: ['owner', 'admin'],
  resolve_queue: ['owner', 'admin', 'mia', 'sales_rep'],
  log_phone_call: ['owner', 'admin', 'mia', 'sales_rep'],
  schedule_meeting: ['owner', 'admin', 'mia', 'sales_rep'],
  update_meeting_status: ['owner', 'admin', 'mia', 'sales_rep'],
  advance_deal_stage: ['owner', 'admin', 'mia', 'sales_rep'],
  update_lead_meta: ['owner', 'admin', 'mia'],
};

interface ActionPayload {
  action: ActionName;
  leadId?: string;
  conversationId?: string | null;
  queueItemId?: string;
  note?: string | null;
  targetStatus?: string;
  dealId?: string;
  targetStage?: string;
  callOutcome?: 'connected' | 'no_answer' | 'voicemail' | 'declined' | 'callback_requested';
  callDurationMinutes?: number;
  meetingType?: 'phone' | 'zoom' | 'office';
  meetingStartsAt?: string;
  meetingEndsAt?: string | null;
  meetingSummary?: string | null;
  meetingUrl?: string | null;
  meetingId?: string;
  meetingStatus?: 'scheduled' | 'held' | 'cancelled' | 'no_show';
  metaUpdates?: {
    goal_summary?: string | null;
    pain_point_summary?: string | null;
    main_blocker?: string | null;
    next_action_type?: string | null;
    inquiry_type?: string | null;
    product_interest?: string | null;
    intake_segment?: string | null;
    primary_track?: string | null;
    interest_topic?: string | null;
  };
}

// Operator-editable lead fields. Two tiers:
//  - free-text fields (capped at META_MAX_LENGTH chars, trimmed, blank → null)
//  - enum fields (rejected if value not in the per-field allowlist)
// Phone is intentionally NOT here — it's the lead identity for routing,
// changing it would orphan inbound webhooks; needs a dedicated migration flow.
const META_TEXT_FIELDS = new Set([
  'goal_summary',
  'pain_point_summary',
  'main_blocker',
  'next_action_type',
  'full_name',
  'email',
  'city',
  'decision_context',
  'lost_reason',
  'interest_topic',
]);
const META_ENUM_FIELDS: Record<string, Set<string>> = {
  lead_heat: new Set(['cold', 'cool', 'warm', 'hot']),
  lead_fit: new Set(['low', 'medium', 'high']),
  readiness_level: new Set(['exploring', 'considering', 'decided', 'paying']),
  inquiry_type: new Set([
    'program_details',
    'pricing',
    'financing',
    'eligibility',
    'property_search',
    'mentorship',
    'purchase_ready',
    'support',
    'unknown',
  ]),
  product_interest: new Set([
    'digital_program',
    'investor_mentorship',
    'contractor_group_purchase',
    'personal_consultation',
    // Legacy values accepted for backwards compatibility with older rows.
    'mentorship',
    'student_tools',
    'financing_guidance',
    'unknown',
  ]),
  intake_segment: new Set([
    'hot_sales',
    'needs_human',
    'needs_nurture',
    'info_seeker',
    'support_or_existing',
    'unknown',
  ]),
  primary_track: new Set(['program', 'presale', 'investor_mentorship']),
};
const META_MAX_LENGTH = 280;

function sanitiseMetaUpdates(input: ActionPayload['metaUpdates']): Record<string, string | null> | null {
  if (!input || typeof input !== 'object') return null;
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(input)) {
    if (META_TEXT_FIELDS.has(k)) {
      if (v === null) {
        out[k] = null;
      } else if (typeof v === 'string') {
        const trimmed = v.trim().slice(0, META_MAX_LENGTH);
        out[k] = trimmed.length === 0 ? null : trimmed;
      }
    } else if (k in META_ENUM_FIELDS) {
      if (v === null) out[k] = null;
      else if (typeof v === 'string' && META_ENUM_FIELDS[k].has(v)) out[k] = v;
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

  const body = (await req.json().catch(() => ({}))) as ActionPayload;
  const {
    action,
    leadId,
    conversationId,
    queueItemId,
    note,
    targetStatus,
    callOutcome,
    callDurationMinutes,
  } = body;

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

  const meta = {
    actor_user_id: staff.userId,
    role: staff.role,
    note: note ?? null,
    correlation_id: correlationId,
  };
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
        leadId,
        queueType: 'human_handoff',
        priorityLevel: 2,
        reason: note ?? 'Assigned to Mia manually',
        queueSummary: note ?? 'Manual assignment to Mia',
        payloadJson: meta,
        createdByActorType: staff.role,
      });
      await logLeadEvent(
        supabase,
        leadId,
        'manual_assign_to_mia',
        staff.role,
        meta,
        conversationId ?? undefined,
        staff.userId,
      );
      break;
    }
    case 'return_to_ai': {
      // Belt-and-suspenders fix for the "AI stays silent after handback" bug:
      //  (a) flip ownership back to AI and clear the human owner indicator.
      //  (b) if Mia's takeover parked the lead in human_handoff, walk it back
      //      to 'responded' — otherwise the playbook router falls into the
      //      qualification branch with stale context and may stay silent.
      //  (c) fire orchestrate-message so the AI evaluates the current
      //      transcript instead of waiting for the next inbound. The
      //      orchestrator handles its own lock + ownership recheck.
      await updateLeadFields(supabase, leadId, {
        ownership_mode: 'ai_active',
        human_owner_id: null,
      });
      const { data: currentLead } = await supabase
        .from('leads')
        .select('lead_status')
        .eq('id', leadId)
        .maybeSingle();
      if (currentLead?.lead_status === 'human_handoff') {
        await transitionLeadStatus(supabase, leadId, 'responded', staff.role, 'manual_return_to_ai');
      }
      await logLeadEvent(
        supabase,
        leadId,
        'manual_return_to_ai',
        staff.role,
        meta,
        conversationId ?? undefined,
        staff.userId,
      );
      // Find the active conversation if the caller didn't supply one — we
      // need to fire orchestrate with a conversationId.
      let cid = conversationId ?? null;
      if (!cid) {
        const { data: conv } = await supabase
          .from('conversations')
          .select('id')
          .eq('lead_id', leadId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        cid = conv?.id ?? null;
      }
      if (cid) {
        const orchestrateUrl = `${env.supabaseUrl()}/functions/v1/orchestrate-message`;
        // Fire-and-forget — the orchestrator handles its own locking +
        // ownership recheck. A 404/timeout here doesn't block the operator's
        // action.
        fetch(orchestrateUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.serviceRoleKey()}`,
            'Content-Type': 'application/json',
            'x-correlation-id': correlationId,
            'x-trigger': 'manual_return_to_ai',
          },
          body: JSON.stringify({ leadId, conversationId: cid }),
        }).catch((err) =>
          log.error('orchestrate_dispatch_after_return_failed', {
            fn: 'admin-actions',
            correlationId,
            leadId,
            err: String(err),
          }),
        );
      }
      break;
    }
    case 'mark_phone_escalation': {
      await updateLeadFields(supabase, leadId, {
        ownership_mode: 'phone_sales_pending',
        requested_phone_call: true,
        last_human_touch_at: ts,
      });
      await ensurePendingQueueItem(supabase, {
        leadId,
        queueType: 'phone_escalation',
        priorityLevel: 1,
        reason: note ?? 'Phone escalation requested',
        queueSummary: note ?? null,
        payloadJson: meta,
        createdByActorType: staff.role,
      });
      await logLeadEvent(
        supabase,
        leadId,
        'manual_phone_escalation',
        staff.role,
        meta,
        conversationId ?? undefined,
        staff.userId,
      );
      break;
    }
    case 'mark_dnc': {
      await updateLeadFields(supabase, leadId, { do_not_contact: true });
      await transitionLeadStatus(supabase, leadId, 'do_not_contact', staff.role, 'manual_mark_dnc');
      await logLeadEvent(
        supabase,
        leadId,
        'manual_mark_dnc',
        staff.role,
        meta,
        conversationId ?? undefined,
        staff.userId,
      );
      break;
    }
    case 'mark_lost': {
      await updateLeadFields(supabase, leadId, { lost_at: ts, lost_reason: note ?? null });
      await transitionLeadStatus(supabase, leadId, 'lost', staff.role, 'manual_mark_lost');
      await logLeadEvent(
        supabase,
        leadId,
        'manual_mark_lost',
        staff.role,
        meta,
        conversationId ?? undefined,
        staff.userId,
      );
      // Tier 4.D.2 — emit deal.lost to the engine. Symmetric to
      // deal.won emit from mark_won. Context includes the most-
      // recent open deal (now flipped to lost) so a bridge rule can
      // condition on its track / value / partner. Errors here don't
      // block the lost marking — automations are best-effort.
      const { data: lostDeal } = await supabase
        .from('deals')
        .select('id, track, value, currency, partner_id, project_id, status')
        .eq('lead_id', leadId)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lostDeal?.id) {
        // Flip the open deal to lost — keeps engine context truthful
        // and stops the deal from appearing in "open" lists. Won deals
        // are left intact (analytics keeps the conversion record).
        await supabase.from('deals').update({
          status: 'lost',
          lost_at: ts,
        }).eq('id', lostDeal.id);
      }
      // Tier 7.B.1 — canonical context shape.
      const leadCtxLost = await buildLeadContext(supabase, leadId);
      if (leadCtxLost) {
        await runMatchingRules(supabase, {
          triggerEvent: 'deal.lost',
          context: {
            lead: leadCtxLost,
            deal: lostDeal ?? null,
            lost_reason: note ?? null,
          },
          contactId: leadId,
          correlationId,
        });
      }
      break;
    }
    case 'mark_won': {
      // Tier 5.B/C — refuse mark_won when no open deal exists.
      // Without an open deal we have no track to start a journey for
      // and no commission to create; the post-sale chain silently
      // breaks. Better to fail loud at the API level and force the
      // operator to create the deal first.
      const { data: openDeal } = await supabase
        .from('deals')
        .select('id, track')
        .eq('lead_id', leadId)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!openDeal) {
        return jsonResponse(req, {
          error: 'אין עסקה פתוחה לליד הזה. צור עסקה לפני סימון כסגירה כדי שהאוטומציות (מסע אונבורדינג, עמלות) יעבדו.',
          code: 'no_open_deal',
        }, 400);
      }
      // The deal needs to be marked won *first* so the downstream
      // engine context picks it up via the .eq('status','won') filter.
      await supabase.from('deals').update({
        status: 'won',
        won_at: ts,
      }).eq('id', openDeal.id);
      await updateLeadFields(supabase, leadId, { won_at: ts });
      await transitionLeadStatus(supabase, leadId, 'won', staff.role, 'manual_mark_won');
      await logLeadEvent(
        supabase,
        leadId,
        'manual_mark_won',
        staff.role,
        meta,
        conversationId ?? undefined,
        staff.userId,
      );
      // Tier 4.C — emit deal.won so engine rules + journey starters
      // listening on that trigger can act (e.g. start program_14d for
      // a won program deal). Pull the deal so the rule's condition
      // can gate on track/value. Errors here don't block the won
      // marking — automations are best-effort.
      const { data: wonDeal } = await supabase
        .from('deals')
        .select('id, track, value, currency, partner_id, project_id')
        .eq('lead_id', leadId)
        .eq('status', 'won')
        .order('won_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      // Tier 7.B.1 — canonical context shape via builder; same shape
      // as deal.lost and lead.created. Tier 7.A.1 depends on this: the
      // investor_mentorship journey's new step-0 (assign_partner) needs
      // primary_track in the lead context to gate correctly.
      const leadCtxWon = await buildLeadContext(supabase, leadId);
      if (leadCtxWon) {
        await runMatchingRules(supabase, {
          triggerEvent: 'deal.won',
          context: {
            lead: leadCtxWon,
            deal: wonDeal ?? null,
          },
          contactId: leadId,
          correlationId,
        });
      }
      break;
    }
    case 'reopen_lead': {
      // The RPC is the source of truth: it role-gates (owner/admin only),
      // clears the right timestamps based on the prior state (won_at on a
      // won lead, lost_at + lost_reason on a lost lead), preserves payments
      // for accounting truth, and inserts audited lead_reopened +
      // lead_status_changed events. It also enforces the state machine for
      // the chosen target.
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
        log.warn('reopen_lead_failed', {
          fn: 'admin-actions',
          correlationId,
          leadId,
          err: reopenErr.message,
        });
        return jsonResponse(req, { error: reopenErr.message }, 400);
      }
      // Reopen also resets DNC/removed_by_request flags + ownership so the
      // AI can take the next turn. The RPC focuses on the audited status
      // change; these side-effects stay here.
      await updateLeadFields(supabase, leadId, {
        ownership_mode: 'ai_active',
        human_owner_id: null,
        do_not_contact: false,
        removed_by_request: false,
      });
      // Fire orchestrate so the AI engages on the current transcript without
      // waiting for the next inbound. Mirrors return_to_ai's pattern.
      let cid = conversationId ?? null;
      if (!cid) {
        const { data: conv } = await supabase
          .from('conversations')
          .select('id')
          .eq('lead_id', leadId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        cid = conv?.id ?? null;
      }
      if (cid) {
        const orchestrateUrl = `${env.supabaseUrl()}/functions/v1/orchestrate-message`;
        fetch(orchestrateUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.serviceRoleKey()}`,
            'Content-Type': 'application/json',
            'x-correlation-id': correlationId,
            'x-trigger': 'manual_reopen_lead',
          },
          body: JSON.stringify({ leadId, conversationId: cid }),
        }).catch((err) =>
          log.error('orchestrate_dispatch_after_reopen_failed', {
            fn: 'admin-actions',
            correlationId,
            leadId,
            err: String(err),
          }),
        );
      }
      break;
    }
    case 'merge_lead_duplicate': {
      // Tier 8.E3 — collapse a duplicate row into the lead being viewed.
      // The RPC repoints every linked table, fills missing contact
      // fields, neutralizes the duplicate, and audits both sides.
      if (staff.role !== 'owner' && staff.role !== 'admin') {
        return jsonResponse(req, { error: 'merge requires owner/admin' }, 403);
      }
      const duplicateLeadId = typeof body.duplicateLeadId === 'string' ? body.duplicateLeadId : null;
      if (!duplicateLeadId) return jsonResponse(req, { error: 'Missing duplicateLeadId' }, 400);
      const { error: mergeErr } = await supabase.rpc('merge_leads', {
        p_survivor: leadId,
        p_duplicate: duplicateLeadId,
      });
      if (mergeErr) {
        log.warn('merge_leads_failed', { fn: 'admin-actions', correlationId, leadId, duplicateLeadId, err: mergeErr.message });
        return jsonResponse(req, { error: mergeErr.message }, 400);
      }
      // Close any pending merge-review queue items that referenced this pair.
      await supabase
        .from('work_queue')
        .update({ status: 'resolved', resolved_at: new Date().toISOString(), resolution_note: 'מוזג' })
        .eq('queue_type', 'manual_review_required')
        .eq('status', 'pending')
        .eq('lead_id', leadId)
        .eq('payload_json->>duplicate_lead_id', duplicateLeadId);
      break;
    }
    case 'update_lead_meta': {
      const sanitised = sanitiseMetaUpdates(body.metaUpdates);
      if (!sanitised) return jsonResponse(req, { error: 'No meta fields to update' }, 400);
      if (sanitised.primary_track) {
        const { data: current } = await supabase.from('leads').select('active_tracks').eq('id', leadId).maybeSingle();
        const currentTracks = Array.isArray(current?.active_tracks)
          ? current.active_tracks.filter((t) => typeof t === 'string') as string[]
          : [];
        (sanitised as Record<string, unknown>).active_tracks = [...new Set([...currentTracks, sanitised.primary_track])];
      }
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
    case 'advance_deal_stage': {
      if (!body.dealId || !body.targetStage) {
        return jsonResponse(req, { error: 'Missing dealId or targetStage' }, 400);
      }
      const { error: stageErr } = await supabase.rpc('advance_deal_stage', {
        p_deal_id: body.dealId,
        p_to_stage: body.targetStage,
        p_actor_type: staff.role,
        p_reason: note ?? 'manual_stage_change',
        p_actor_id: staff.userId,
        p_metadata: { correlation_id: correlationId },
      });
      if (stageErr) return jsonResponse(req, { error: stageErr.message }, 400);
      break;
    }
    case 'update_meeting_status': {
      if (!body.meetingId) return jsonResponse(req, { error: 'Missing meetingId' }, 400);
      const meetingStatus = body.meetingStatus;
      if (!meetingStatus || !['scheduled', 'held', 'cancelled', 'no_show'].includes(meetingStatus)) {
        return jsonResponse(req, { error: 'Invalid meetingStatus' }, 400);
      }
      const { data: meeting, error: meetingLoadErr } = await supabase
        .from('meetings')
        .select('id, lead_id, meeting_type, starts_at')
        .eq('id', body.meetingId)
        .eq('lead_id', leadId)
        .maybeSingle();
      if (meetingLoadErr) return jsonResponse(req, { error: meetingLoadErr.message }, 400);
      if (!meeting) return jsonResponse(req, { error: 'Meeting not found for lead' }, 404);
      const statusMeta = { ...meta, meeting_id: body.meetingId, status: meetingStatus };
      const { error: meetingUpdateErr } = await supabase
        .from('meetings')
        .update({ status: meetingStatus, summary: note ?? undefined, metadata: statusMeta })
        .eq('id', body.meetingId)
        .eq('lead_id', leadId);
      if (meetingUpdateErr) return jsonResponse(req, { error: meetingUpdateErr.message }, 400);
      await updateLeadFields(supabase, leadId, { last_human_touch_at: ts });
      await logLeadEvent(
        supabase,
        leadId,
        `meeting_${meetingStatus}`,
        staff.role,
        { ...statusMeta, meeting_type: meeting.meeting_type, starts_at: meeting.starts_at },
        conversationId ?? undefined,
        staff.userId,
      );
      if (meetingStatus === 'no_show' || meetingStatus === 'cancelled') {
        const followupReason = meetingStatus === 'no_show'
          ? 'פולואפ אחרי לקוח שלא הגיע לפגישה'
          : 'פולואפ אחרי פגישה שבוטלה';
        await ensurePendingQueueItem(supabase, {
          leadId,
          queueType: 'phone_escalation',
          priorityLevel: meetingStatus === 'no_show' ? 1 : 2,
          reason: followupReason,
          queueSummary: followupReason,
          dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          payloadJson: { ...statusMeta, meeting_type: meeting.meeting_type, starts_at: meeting.starts_at },
          createdByActorType: staff.role,
        });
      }
      break;
    }
    case 'schedule_meeting': {
      const meetingType = body.meetingType ?? 'phone';
      if (!['phone', 'zoom', 'office'].includes(meetingType)) {
        return jsonResponse(req, { error: 'Invalid meetingType' }, 400);
      }
      if (!body.meetingStartsAt) return jsonResponse(req, { error: 'Missing meetingStartsAt' }, 400);
      const startsAt = new Date(body.meetingStartsAt);
      if (!Number.isFinite(startsAt.getTime())) return jsonResponse(req, { error: 'Invalid meetingStartsAt' }, 400);
      const endsAt = body.meetingEndsAt ? new Date(body.meetingEndsAt) : null;
      if (endsAt && !Number.isFinite(endsAt.getTime())) return jsonResponse(req, { error: 'Invalid meetingEndsAt' }, 400);
      if (endsAt && endsAt.getTime() <= startsAt.getTime()) return jsonResponse(req, { error: 'meetingEndsAt must be after meetingStartsAt' }, 400);
      const summary = typeof body.meetingSummary === 'string' && body.meetingSummary.trim()
        ? body.meetingSummary.trim().slice(0, 500)
        : note ?? null;
      const meetingMeta = {
        ...meta,
        source: 'manual_admin_action',
        correlation_id: correlationId,
      };
      const { data: meeting, error: meetingErr } = await supabase.from('meetings').insert({
        lead_id: leadId,
        deal_id: body.dealId ?? null,
        meeting_type: meetingType,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt ? endsAt.toISOString() : null,
        assigned_to_user_id: staff.userId,
        status: 'scheduled',
        summary,
        meeting_url: body.meetingUrl ?? null,
        metadata: meetingMeta,
      }).select('id').single();
      if (meetingErr) return jsonResponse(req, { error: meetingErr.message }, 400);
      await updateLeadFields(supabase, leadId, {
        next_action_type: 'scheduled_meeting',
        next_action_due_at: startsAt.toISOString(),
        last_human_touch_at: ts,
      });
      await logLeadEvent(
        supabase,
        leadId,
        'meeting_scheduled',
        staff.role,
        { ...meetingMeta, meeting_id: meeting?.id ?? null, meeting_type: meetingType, starts_at: startsAt.toISOString() },
        conversationId ?? undefined,
        staff.userId,
      );
      break;
    }
    case 'log_phone_call': {
      const callMeta = {
        ...meta,
        outcome: callOutcome ?? 'connected',
        duration_minutes: callDurationMinutes ?? null,
      };
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
      await logLeadEvent(
        supabase,
        leadId,
        'phone_call_logged',
        staff.role,
        callMeta,
        conversationId ?? undefined,
        staff.userId,
      );
      break;
    }
    default:
      return jsonResponse(req, { error: 'Unsupported action' }, 400);
  }

  log.info('admin_action', { fn: 'admin-actions', correlationId, userId: staff.userId, action, leadId });
  return jsonResponse(req, { ok: true, action });
});
