// Frontend response contracts. The fields mirror the columns selected by
// the corresponding Edge Functions (`leads-list`, `lead-detail`, etc.).

export type LeadStatus =
  | 'new' | 'first_contact_sent' | 'responded' | 'qualified' | 'nurture'
  | 'checkout_pushed' | 'payment_pending' | 'human_handoff' | 'won' | 'lost'
  | 'dormant' | 'onboarding_active' | 'active_student' | 'do_not_contact'
  | 'removed_by_request' | 'duplicate' | 'manual_review_required';

export type LeadHeat = 'hot' | 'warm' | 'cool' | 'cold';

export type OwnershipMode =
  | 'ai_active' | 'mia_active' | 'phone_sales_pending' | 'shared_watch' | 'suppressed';

export interface LeadRow {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  source: string;
  lead_status: LeadStatus;
  lead_heat: LeadHeat;
  ownership_mode: OwnershipMode;
  lead_score: number;
  payment_status: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  do_not_contact: boolean;
  removed_by_request: boolean;
  updated_at: string;
  created_at: string;
}

export type LeadFit = 'low' | 'medium' | 'high';
export type ReadinessLevel = 'exploring' | 'considering' | 'decided' | 'paying';

export interface LeadDetail extends LeadRow {
  source_detail: string | null;
  source_campaign: string | null;
  webinar_name: string | null;
  city: string | null;
  conversation_summary: string | null;
  pain_point_summary: string | null;
  goal_summary: string | null;
  main_blocker: string | null;
  notes_internal: string | null;
  next_action_type: string | null;
  next_action_due_at: string | null;
  payment_completed_at: string | null;
  won_at: string | null;
  lost_at: string | null;
  lost_reason: string | null;
  decision_context: string | null;
  lead_fit: LeadFit | null;
  readiness_level: ReadinessLevel | null;
  human_owner_id: string | null;
  requested_phone_call: boolean;
  last_human_touch_at: string | null;
  ai_playbook_stage: string | null;
  ai_playbook_stage_at: string | null;
}

export interface MessageRow {
  id: string;
  lead_id: string;
  conversation_id: string;
  provider_message_id: string | null;
  sender_type: 'lead' | 'ai' | 'mia' | 'sales_rep' | 'system' | 'admin';
  sender_name: string | null;
  direction: 'inbound' | 'outbound' | 'internal';
  message_type: 'text' | 'media' | 'template' | 'system_event';
  content_text: string | null;
  provider_status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | null;
  provider_error: string | null;
  delivered_at: string | null;
  read_at: string | null;
  created_at: string;
}

export interface ConversationRow {
  id: string;
  lead_id: string;
  channel: string;
  ownership_mode: OwnershipMode;
  is_open: boolean;
  last_activity_at: string | null;
}

export interface QueueRow {
  id: string;
  lead_id: string;
  queue_type: string;
  priority_level: number;
  status: 'pending' | 'claimed' | 'resolved' | 'canceled';
  reason: string | null;
  queue_summary: string | null;
  due_at: string | null;
  created_at: string;
  resolution_note: string | null;
  leads?: {
    id: string; full_name: string | null; phone: string | null;
    lead_status: LeadStatus; lead_heat: LeadHeat; ownership_mode: OwnershipMode;
  } | null;
}

export interface TaskRow {
  id: string;
  lead_id: string;
  task_type: string;
  task_status: 'open' | 'done' | 'canceled' | 'expired';
  owner_type: string;
  title: string;
  description: string | null;
  priority_level: number;
  due_at: string | null;
  created_at: string;
}

export interface EventRow {
  id: string;
  lead_id: string;
  conversation_id: string | null;
  event_type: string;
  actor_type: string;
  event_payload: Record<string, unknown>;
  created_at: string;
}

export interface DashboardSummary {
  leadsToday: number;
  unansweredNow: number;
  hotLeadsNow: number;
  paymentPendingNow: number;
  slaRiskCount: number;
  funnel: {
    new_count: number; first_contact_count: number; responded_count: number;
    qualified_count: number; checkout_count: number; payment_pending_count: number;
    won_count: number; lost_count: number; dormant_count: number;
  };
  queueCounts: Record<string, number>;
  // Per-source intake counters for the last 24h / 7d. Always present; may be {}.
  sourceHealth?: Record<string, { h24: number; d7: number }>;
}

export type AttentionKind = 'queue' | 'mia_reply' | 'overdue_action';

export interface AttentionRow {
  kind: AttentionKind;
  ref_id: string;
  lead_id: string;
  lead_name: string | null;
  lead_phone: string | null;
  lead_status: LeadStatus;
  lead_heat: LeadHeat | null;
  ownership_mode: OwnershipMode;
  priority_level: number;
  reason: string | null;
  due_at: string | null;
  created_at: string | null;
}

export interface ApiOk { ok: true; }
