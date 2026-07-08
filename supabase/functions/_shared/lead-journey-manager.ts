import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { ensurePendingQueueItem } from './queue-service.ts';
import { logLeadEvent, transitionLeadStatus, updateLeadFields, type LeadRow } from './lead-service.ts';

type LeadJourneyClass =
  | 'suppressed'
  | 'closed'
  | 'missing_contact'
  | 'needs_ai_response'
  | 'human_requested'
  | 'hot_sales_ready'
  | 'payment_pending'
  | 'waiting_for_lead'
  | 'nurture_due'
  | 'dormant_review'
  | 'old_unresponsive'
  | 'active_ai_conversation';

interface LeadJourneyCounters {
  scanned: number;
  skipped?: string;
  classified: Record<LeadJourneyClass, number>;
  queued: Record<string, number>;
  transitioned: Record<string, number>;
  errors: Array<{ leadId: string; stage: string; message: string }>;
}

const TERMINAL_STATUSES = new Set([
  'won',
  'lost',
  'do_not_contact',
  'removed_by_request',
  'duplicate',
]);

const OPEN_STATUSES = [
  'new',
  'first_contact_sent',
  'responded',
  'qualified',
  'nurture',
  'checkout_pushed',
  'payment_pending',
  'human_handoff',
  'dormant',
  'manual_review_required',
];

function hoursSince(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (now - t) / 3600_000);
}

function hasInboundAfterOutbound(lead: LeadRow): boolean {
  if (!lead.last_inbound_at) return false;
  if (!lead.last_outbound_at) return true;
  return Date.parse(lead.last_inbound_at) > Date.parse(lead.last_outbound_at);
}

function hasOutboundAfterInbound(lead: LeadRow): boolean {
  if (!lead.last_outbound_at) return false;
  if (!lead.last_inbound_at) return true;
  return Date.parse(lead.last_outbound_at) >= Date.parse(lead.last_inbound_at);
}

function isHotLead(lead: LeadRow): boolean {
  return lead.lead_heat === 'hot' || Number(lead.lead_score ?? 0) >= 70 || lead.lead_status === 'qualified';
}

function classifyLeadJourney(lead: LeadRow, now = Date.now()): LeadJourneyClass {
  if (lead.do_not_contact || lead.removed_by_request) return 'suppressed';
  if (TERMINAL_STATUSES.has(lead.lead_status)) return 'closed';
  if (!lead.phone && !lead.email) return 'missing_contact';
  if (lead.lead_status === 'payment_pending' || lead.payment_status === 'pending') return 'payment_pending';
  if (lead.ownership_mode === 'mia_active' || lead.ownership_mode === 'phone_sales_pending' || lead.requested_phone_call) {
    return 'human_requested';
  }
  if (hasInboundAfterOutbound(lead) && lead.ownership_mode === 'ai_active') return 'needs_ai_response';
  if (isHotLead(lead) && lead.ownership_mode === 'ai_active') return 'hot_sales_ready';

  const lastOutboundHours = hoursSince(lead.last_outbound_at, now);
  const createdHours = hoursSince(String(lead.created_at ?? ''), now);
  const noReplyAfterOutbound = hasOutboundAfterInbound(lead) && lastOutboundHours !== null;

  if (noReplyAfterOutbound && lastOutboundHours >= 30 * 24) return 'old_unresponsive';
  if (noReplyAfterOutbound && lastOutboundHours >= 14 * 24) return 'dormant_review';
  if (noReplyAfterOutbound && lastOutboundHours >= 24) return 'nurture_due';

  if (!lead.last_outbound_at && createdHours !== null && createdHours >= 4) return 'needs_ai_response';
  if (hasOutboundAfterInbound(lead)) return 'waiting_for_lead';
  return 'active_ai_conversation';
}

function bump<K extends string>(map: Record<K, number>, key: K): void {
  map[key] = (map[key] ?? 0) + 1;
}

async function safeTransition(
  supabase: SupabaseClient,
  counters: LeadJourneyCounters,
  lead: LeadRow,
  target: string,
  reason: string,
): Promise<void> {
  if (lead.lead_status === target) return;
  try {
    await transitionLeadStatus(supabase, lead.id, target, 'system', reason);
    bump(counters.transitioned, target);
  } catch (err) {
    counters.errors.push({ leadId: lead.id, stage: `transition:${target}`, message: String(err) });
  }
}

async function queue(
  supabase: SupabaseClient,
  counters: LeadJourneyCounters,
  lead: LeadRow,
  queueType: string,
  priorityLevel: number,
  reason: string,
  payloadJson: Record<string, unknown>,
  dueAt?: string,
): Promise<void> {
  try {
    const item = await ensurePendingQueueItem(supabase, {
      leadId: lead.id,
      queueType,
      priorityLevel,
      reason,
      dueAt,
      payloadJson,
      createdByActorType: 'system',
    });
    if (item.created) bump(counters.queued, queueType);
  } catch (err) {
    counters.errors.push({ leadId: lead.id, stage: `queue:${queueType}`, message: String(err) });
  }
}

async function applyLeadJourneyRule(
  supabase: SupabaseClient,
  counters: LeadJourneyCounters,
  lead: LeadRow,
  classification: LeadJourneyClass,
  correlationId: string,
  now = Date.now(),
): Promise<void> {
  const payload = { correlationId, classification, source: lead.source, status: lead.lead_status };

  if (classification === 'missing_contact') {
    await queue(supabase, counters, lead, 'manual_review_required', 2, 'Lead has no usable phone or email', payload);
    await safeTransition(supabase, counters, lead, 'manual_review_required', 'lead_journey_missing_contact');
    return;
  }

  if (classification === 'needs_ai_response') {
    await queue(supabase, counters, lead, 'first_response_due', 1, 'Lead is waiting for an AI response', payload, new Date(now).toISOString());
    return;
  }

  if (classification === 'human_requested') {
    await queue(supabase, counters, lead, 'human_handoff', 1, 'Lead needs human handling or requested a call', payload);
    return;
  }

  if (classification === 'hot_sales_ready') {
    await queue(supabase, counters, lead, 'phone_escalation', 1, 'Hot lead should be moved to phone sales', payload);
    await updateLeadFields(supabase, lead.id, {
      ownership_mode: 'phone_sales_pending',
      requested_phone_call: true,
    });
    await safeTransition(supabase, counters, lead, 'human_handoff', 'lead_journey_hot_sales_ready');
    return;
  }

  if (classification === 'payment_pending') {
    await queue(supabase, counters, lead, 'payment_pending', 1, 'Payment is pending and needs rescue', payload);
    return;
  }

  if (classification === 'nurture_due') {
    await queue(supabase, counters, lead, 'nurture_due', 3, 'Lead has not replied after follow-up window', payload);
    if (lead.lead_status === 'responded' || lead.lead_status === 'first_contact_sent') {
      await safeTransition(supabase, counters, lead, 'nurture', 'lead_journey_nurture_due');
    }
    return;
  }

  if (classification === 'dormant_review') {
    await queue(supabase, counters, lead, 'dormant_review', 4, 'Lead is quiet for 14 days; review for reactivation or closure', payload);
    if (lead.lead_status === 'nurture') {
      await safeTransition(supabase, counters, lead, 'dormant', 'lead_journey_dormant_review');
    }
    return;
  }

  if (classification === 'old_unresponsive') {
    await queue(supabase, counters, lead, 'low_fit_cleanup', 5, 'Lead is unresponsive for 30 days; close unless there is a clear reason not to', payload);
    if (lead.lead_status === 'dormant' || lead.lead_status === 'nurture') {
      await safeTransition(supabase, counters, lead, 'lost', 'lead_journey_old_unresponsive');
    }
  }
}

async function latestLoggedClassification(
  supabase: SupabaseClient,
  leadId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('lead_events')
    .select('event_payload')
    .eq('lead_id', leadId)
    .eq('event_type', 'lead_journey_classified')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  const payload = data?.event_payload as Record<string, unknown> | null | undefined;
  return typeof payload?.classification === 'string' ? payload.classification : null;
}

export async function runLeadJourneyManager(
  supabase: SupabaseClient,
  correlationId: string,
  limit = 200,
): Promise<LeadJourneyCounters> {
  const counters: LeadJourneyCounters = {
    scanned: 0,
    classified: {} as Record<LeadJourneyClass, number>,
    queued: {},
    transitioned: {},
    errors: [],
  };

  const { data: rule } = await supabase
    .from('automation_rules')
    .select('enabled')
    .eq('code', 'lead_journey_manager')
    .maybeSingle();
  if (rule && rule.enabled === false) {
    counters.skipped = 'automation_rule_disabled';
    return counters;
  }

  const { data: leads, error } = await supabase
    .from('leads')
    .select('*')
    .in('lead_status', OPEN_STATUSES)
    .eq('do_not_contact', false)
    .eq('removed_by_request', false)
    .order('updated_at', { ascending: true })
    .limit(limit);

  if (error) {
    counters.errors.push({ leadId: 'query', stage: 'lead_scan', message: error.message });
    return counters;
  }

  const now = Date.now();
  for (const lead of (leads ?? []) as LeadRow[]) {
    counters.scanned++;
    const classification = classifyLeadJourney(lead, now);
    bump(counters.classified, classification);
    try {
      const previousClassification = await latestLoggedClassification(supabase, lead.id);
      await applyLeadJourneyRule(supabase, counters, lead, classification, correlationId, now);
      if (previousClassification !== classification) {
        await logLeadEvent(supabase, lead.id, 'lead_journey_classified', 'system', {
          classification,
          correlation_id: correlationId,
          previous_classification: previousClassification,
        });
      }
    } catch (err) {
      counters.errors.push({ leadId: lead.id, stage: 'apply_rule', message: String(err) });
    }
  }

  return counters;
}
