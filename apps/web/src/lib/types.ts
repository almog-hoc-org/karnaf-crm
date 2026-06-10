// Frontend response contracts. The fields mirror the columns selected by
// the corresponding Edge Functions (`leads-list`, `lead-detail`, etc.).

export type LeadStatus =
  | 'new'
  | 'first_contact_sent'
  | 'responded'
  | 'qualified'
  | 'nurture'
  | 'checkout_pushed'
  | 'payment_pending'
  | 'human_handoff'
  | 'won'
  | 'lost'
  | 'dormant'
  | 'onboarding_active'
  | 'active_student'
  | 'do_not_contact'
  | 'removed_by_request'
  | 'duplicate'
  | 'manual_review_required';

export type LeadHeat = 'hot' | 'warm' | 'cool' | 'cold';

export type OwnershipMode =
  | 'ai_active'
  | 'mia_active'
  | 'phone_sales_pending'
  | 'shared_watch'
  | 'suppressed';

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
  inquiry_type?: InquiryType | null;
  product_interest?: ProductInterest | null;
  intake_segment?: IntakeSegment | null;
  suggested_next_action?: string | null;
  primary_track?: PrdTrack | null;
  active_tracks?: PrdTrack[] | null;
  interest_topic?: string | null;
  tags?: string[] | null;
  consent_whatsapp?: boolean | null;
  consent_email?: boolean | null;
}

// Tier 0.E — Contact-centric type aliases. The v4 spec calls the
// central entity "איש קשר"; the codebase still uses `leads` until the
// physical rename in Tier 1. New code should reach for these aliases
// so the conceptual shift is visible at the call site.
export type ContactRow = LeadRow;

export type PrdTrack = 'program' | 'presale' | 'investor_mentorship';

export interface DealRow {
  id: string;
  lead_id: string;
  track: PrdTrack;
  stage: string;
  value: number | null;
  currency: string;
  presale_project: string | null;
  partner_name: string | null;
  expected_close: string | null;
  status: 'open' | 'won' | 'lost' | 'cancelled';
  owner_user_id: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface MeetingRow {
  id: string;
  lead_id: string;
  deal_id: string | null;
  meeting_type: 'phone' | 'zoom' | 'office';
  starts_at: string;
  ends_at: string | null;
  assigned_to_user_id: string | null;
  status: 'scheduled' | 'held' | 'cancelled' | 'no_show';
  summary: string | null;
  calendar_event_id: string | null;
  meeting_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProgramMemberRow {
  lead_id: string;
  joined_at: string;
  progress_stage: string;
  client_profile: Record<string, unknown>;
  keep_alive_state: Record<string, unknown>;
  portal_user_id: string | null;
  updated_at: string;
}

export type LeadFit = 'low' | 'medium' | 'high';
export type ReadinessLevel = 'exploring' | 'considering' | 'decided' | 'paying';
export type InquiryType =
  | 'program_details'
  | 'pricing'
  | 'financing'
  | 'eligibility'
  | 'property_search'
  | 'mentorship'
  | 'purchase_ready'
  | 'support'
  | 'unknown';
export type ProductInterest =
  | 'digital_program'
  | 'investor_mentorship'
  | 'contractor_group_purchase'
  | 'personal_consultation'
  // Legacy values kept for rows classified before the product model was sharpened.
  | 'mentorship'
  | 'student_tools'
  | 'financing_guidance'
  | 'unknown';
export type IntakeSegment =
  | 'hot_sales'
  | 'needs_human'
  | 'needs_nurture'
  | 'info_seeker'
  | 'support_or_existing'
  | 'unknown';

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
  inquiry_type: InquiryType | null;
  product_interest: ProductInterest | null;
  intake_segment: IntakeSegment | null;
  classification_confidence: 'high' | 'medium' | 'low' | null;
  classification_summary: string | null;
  suggested_next_action: string | null;
  handoff_reason: string | null;
  classification_updated_at: string | null;
}

// Tier 0.E — Contact alias for the rich detail view. Keep in lockstep
// with LeadDetail; remove the alias once Tier 1 lands the physical
// rename and the codebase drops "Lead" terminology entirely.
export type ContactDetail = LeadDetail;

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
  payload_json?: Record<string, unknown> | null;
  resolution_note: string | null;
  leads?: {
    id: string;
    full_name: string | null;
    phone: string | null;
    lead_status: LeadStatus;
    lead_heat: LeadHeat;
    ownership_mode: OwnershipMode;
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

// Tier 0.A — unified activity feed (migration 054). Mirror of messages /
// lead_events / lead_tasks / work_queue into one chronologically-sortable
// stream that the Universal Record Screen reads. Discriminator is
// `activity_type`; other fields are populated per type.
export type ActivityType = 'message' | 'event' | 'task' | 'queue_item' | 'note' | 'call_log' | 'meeting';

export interface ActivityRow {
  id: string;
  contact_id: string;
  occurred_at: string;
  activity_type: ActivityType;
  actor_type: string;
  conversation_id: string | null;
  deal_id: string | null;
  meeting_id: string | null;
  actor_user_id: string | null;
  title: string | null;
  body: string | null;
  status: string | null;
  priority_level: number | null;
  due_at: string | null;
  completed_at: string | null;
  direction: 'inbound' | 'outbound' | 'internal' | null;
  source_table: 'messages' | 'lead_events' | 'lead_tasks' | 'work_queue' | 'native';
  source_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface DashboardSummary {
  leadsToday: number;
  unansweredNow: number;
  hotLeadsNow: number;
  paymentPendingNow: number;
  slaRiskCount: number;
  funnel: {
    new_count: number;
    first_contact_count: number;
    responded_count: number;
    qualified_count: number;
    checkout_count: number;
    payment_pending_count: number;
    won_count: number;
    lost_count: number;
    dormant_count: number;
  };
  queueCounts: Record<string, number>;
  // Per-source intake counters for the last 24h / 7d. Always present; may be {}.
  sourceHealth?: Record<string, { h24: number; d7: number }>;
}

// Extended in Tier 0.C to include the new fall-through kinds emitted by
// the sla-worker watchers (deal_stalled / meeting_outcome_pending /
// phone_overdue) and the pre-existing ai_stuck / phone_escalation that
// were previously lumped under 'queue'. Anything not enumerated falls
// back to 'queue' at the RPC layer.
export type AttentionKind =
  | 'queue'
  | 'mia_reply'
  | 'overdue_action'
  | 'deal_stalled'
  | 'meeting_outcome_pending'
  | 'phone_overdue'
  | 'ai_stuck'
  | 'phone_escalation';

export interface AttentionRow {
  kind: AttentionKind;
  ref_id: string;
  lead_id: string;
  lead_name: string | null;
  lead_phone: string | null;
  lead_status: LeadStatus;
  lead_heat: LeadHeat | null;
  ownership_mode: OwnershipMode;
  product_interest?: ProductInterest | null;
  suggested_next_action?: string | null;
  intake_segment?: IntakeSegment | null;
  queue_type?: string | null;
  queue_summary?: string | null;
  last_inbound_at?: string | null;
  last_outbound_at?: string | null;
  priority_level: number;
  reason: string | null;
  due_at: string | null;
  created_at: string | null;
}

export interface ApiOk {
  ok: true;
}
