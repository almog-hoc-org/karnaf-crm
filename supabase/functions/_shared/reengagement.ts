// Re-engagement nudges (run nightly). Two flows:
//   1. check-in   — ~7 days after a lead was handed to a human and went quiet
//                   (human touched, lead never replied) → "still need anything?".
//   2. reactivation — ~60 days after a lead went lost/dormant → "still relevant?".
//
// HARD GATE: both send via a Meta-approved WhatsApp template (24h-window rule),
// so the whole feature is OFF (`reengagement.enabled=false`) until such a template
// exists. Opt-outs (do_not_contact / removed_by_request) are ALWAYS excluded, and
// each flow is one-shot per lead (guarded by a lead_event).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendWhatsAppTemplate } from './whatsapp-provider.ts';
import { logLeadEvent } from './lead-service.ts';
import { log } from './logger.ts';

export interface ReengagementConfig {
  enabled: boolean;
  checkinDays: number;
  reactivationDays: number;
  templateName: string;
}

const CHECKIN_EVENT = 'reengagement_checkin_sent';
const REACTIVATION_EVENT = 'reengagement_reactivation_sent';
// Statuses that mean "do not nudge as an open lead" for the check-in flow.
const CLOSED_OR_DONE = new Set([
  'won', 'lost', 'dormant', 'do_not_contact', 'removed_by_request',
  'active_student', 'onboarding_active', 'duplicate',
]);

type LeadRow = Record<string, unknown>;

function contextLine(lead: LeadRow): string {
  return (
    (lead.goal_summary as string) ||
    (lead.pain_point_summary as string) ||
    (lead.interest_topic as string) ||
    'הפנייה שלך לקרנף נדל״ן'
  );
}

async function alreadySent(supabase: SupabaseClient, leadId: string, eventType: string): Promise<boolean> {
  const { data } = await supabase
    .from('lead_events')
    .select('id')
    .eq('lead_id', leadId)
    .eq('event_type', eventType)
    .limit(1)
    .maybeSingle();
  return !!data;
}

async function sendNudge(
  supabase: SupabaseClient,
  lead: LeadRow,
  cfg: ReengagementConfig,
  eventType: string,
  correlationId: string,
): Promise<boolean> {
  const phone = lead.phone as string | null;
  if (!phone) return false;
  const res = await sendWhatsAppTemplate(phone, cfg.templateName, [
    { name: 'context', value: contextLine(lead) },
  ]);
  if (!res.ok) {
    log.warn('reengagement_send_failed', { fn: 'reengagement', correlationId, leadId: lead.id as string, eventType, err: res.error });
    return false;
  }
  await logLeadEvent(supabase, lead.id as string, eventType, 'system', {
    template: cfg.templateName,
    correlation_id: correlationId,
  });
  return true;
}

export async function runReengagement(
  supabase: SupabaseClient,
  cfg: ReengagementConfig,
  correlationId: string,
): Promise<{ data: { checkins: number; reactivations: number; disabled?: boolean }; error: null }> {
  // Dormant until an approved template is configured.
  if (!cfg.enabled || !cfg.templateName) {
    return { data: { checkins: 0, reactivations: 0, disabled: true }, error: null };
  }

  const now = Date.now();
  const SELECT = 'id, phone, full_name, lead_status, ownership_mode, last_human_touch_at, last_inbound_at, last_outbound_at, updated_at, goal_summary, pain_point_summary, interest_topic, primary_track, do_not_contact, removed_by_request';

  // ── 1. check-in: handed to a human ~checkinDays ago, lead never replied ──
  let checkins = 0;
  const checkinUpper = new Date(now - cfg.checkinDays * 86400_000).toISOString();
  const checkinLower = new Date(now - (cfg.checkinDays + 2) * 86400_000).toISOString();
  const { data: checkinRows, error: checkinErr } = await supabase
    .from('leads')
    .select(SELECT)
    .in('ownership_mode', ['mia_active', 'phone_sales_pending'])
    .eq('do_not_contact', false)
    .eq('removed_by_request', false)
    .gte('last_human_touch_at', checkinLower)
    .lt('last_human_touch_at', checkinUpper);
  if (checkinErr) return { data: { checkins: 0, reactivations: 0 }, error: null };
  for (const lead of checkinRows ?? []) {
    if (CLOSED_OR_DONE.has(String(lead.lead_status))) continue;
    // Skip if the lead replied since the human last touched them (conversation is live).
    const touched = lead.last_human_touch_at ? Date.parse(lead.last_human_touch_at as string) : 0;
    const replied = lead.last_inbound_at ? Date.parse(lead.last_inbound_at as string) : 0;
    if (replied >= touched) continue;
    if (await alreadySent(supabase, lead.id as string, CHECKIN_EVENT)) continue;
    if (await sendNudge(supabase, lead, cfg, CHECKIN_EVENT, correlationId)) checkins++;
  }

  // ── 2. reactivation: lost/dormant, no activity in reactivationDays ──
  let reactivations = 0;
  const reactCutoff = now - cfg.reactivationDays * 86400_000;
  const { data: reactRows, error: reactErr } = await supabase
    .from('leads')
    .select(SELECT)
    .in('lead_status', ['lost', 'dormant'])
    .eq('do_not_contact', false)
    .eq('removed_by_request', false);
  if (reactErr) return { data: { checkins, reactivations: 0 }, error: null };
  for (const lead of reactRows ?? []) {
    const lastActivity = Math.max(
      lead.last_inbound_at ? Date.parse(lead.last_inbound_at as string) : 0,
      lead.last_outbound_at ? Date.parse(lead.last_outbound_at as string) : 0,
      lead.updated_at ? Date.parse(lead.updated_at as string) : 0,
    );
    if (lastActivity > reactCutoff) continue;
    if (await alreadySent(supabase, lead.id as string, REACTIVATION_EVENT)) continue;
    if (await sendNudge(supabase, lead, cfg, REACTIVATION_EVENT, correlationId)) reactivations++;
  }

  log.info('reengagement_run', { fn: 'reengagement', correlationId, checkins, reactivations });
  return { data: { checkins, reactivations }, error: null };
}
