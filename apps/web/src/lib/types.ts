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
  // Legacy text shadows kept for one release; new code should join on
  // partner_id / project_id and read names from partners / projects.
  presale_project: string | null;
  partner_name: string | null;
  // Tier 1.C — FKs to the real entities. Nullable for the legacy rows
  // the backfill couldn't match cleanly + for program-track deals that
  // never have a partner or a presale project.
  partner_id: string | null;
  project_id: string | null;
  expected_close: string | null;
  status: 'open' | 'won' | 'lost' | 'cancelled';
  owner_user_id: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  // Tier 1.D — workflow-trigger timestamps. seriousness_deposit_paid_at
  // is the B11 trigger (creates commission); contract_signed_at is B12
  // (moves commission to to_bill).
  seriousness_deposit_paid_at?: string | null;
  contract_signed_at?: string | null;
  // Tier 1.E — joins from lead-detail. Each is null on deal rows from
  // endpoints that don't request the embed (leads-list, dashboard).
  partner?: { id: string; full_name: string; domain: PartnerDomain } | null;
  project?: { id: string; name: string; city: string | null } | null;
  commission?: {
    id: string;
    status: CommissionStatus;
    amount_due: number;
    amount_received: number | null;
    currency: string;
    to_bill_at: string | null;
    paid_at: string | null;
  } | null;
}

// Tier 1.A — Partner = freelancer / external service provider that
// closes for Karnaf. commission_to_karnaf_pct is Karnaf's slice of
// the deal value (the partner's take is the complement).
export type PartnerDomain = 'investor_mentorship' | 'appraisal' | 'legal' | 'financing' | 'other';
export type PartnerStatus = 'active' | 'paused' | 'archived';

export interface PartnerRow {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  domain: PartnerDomain;
  commission_to_karnaf_pct: number;
  status: PartnerStatus;
  user_id: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PartnerWorkloadRow {
  partner_id: string;
  full_name: string;
  domain: PartnerDomain;
  commission_to_karnaf_pct: number;
  status: PartnerStatus;
  open_deals_count: number;
  won_deals_count: number;
}

// Tier 1.B — Project = a presale (קבוצת רכישה) project. status walks
// recruiting → closed → executed; cancelled is the off-ramp.
export type ProjectType = 'residential' | 'commercial' | 'mixed';
export type ProjectStatus = 'recruiting' | 'closed' | 'executed' | 'cancelled';

export interface ProjectRow {
  id: string;
  name: string;
  city: string | null;
  developer_name: string | null;
  project_type: ProjectType;
  total_units: number | null;
  price_per_unit: number | null;
  target_amount: number | null;
  currency: string;
  status: ProjectStatus;
  target_date: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProjectFundingRow {
  project_id: string;
  name: string;
  city: string | null;
  total_units: number | null;
  price_per_unit: number | null;
  target_amount: number | null;
  currency: string;
  status: ProjectStatus;
  target_date: string | null;
  committed_amount: number;
  committed_units: number;
  funding_pct: number | null;
}

// Tier 3 — dashboard aggregate rows from the views in migration 064.
export interface CommissionMonthlyRow {
  month: string;
  status: 'pending' | 'to_bill' | 'paid' | 'cancelled';
  count: number;
  amount_total: number;
}

export interface CommissionByPartnerRow {
  partner_id: string;
  full_name: string;
  domain: string;
  commission_to_karnaf_pct: number;
  commissions_count: number;
  paid_count: number;
  open_count: number;
  paid_total: number;
  open_total: number;
  avg_days_to_paid: number | null;
}

export interface PresaleAtRiskRow {
  project_id: string;
  name: string;
  city: string | null;
  target_date: string | null;
  target_amount: number | null;
  currency: string;
  committed_amount: number;
  funding_pct: number | null;
  days_to_target: number | null;
  risk_level: 'ok' | 'amber' | 'red' | 'overdue';
}

export interface RetentionStageRow {
  progress_stage: string;
  members_count: number;
  active_count: number;
  dormant_count: number;
  active_pct: number | null;
}

export interface ReportsBundle {
  commissions: { monthly: CommissionMonthlyRow[]; byPartner: CommissionByPartnerRow[] };
  presale: { atRisk: PresaleAtRiskRow[] };
  retention: { stages: RetentionStageRow[] };
}

// Tier 4.B — customer journeys.
export type JourneyRunStatus = 'active' | 'completed' | 'cancelled' | 'failed';

export interface JourneyStepDef {
  name?: string;
  delay_hours?: number;
  conditions?: Record<string, unknown>;
  actions?: Array<Record<string, unknown>>;
}

export interface JourneyDefinitionRow {
  id: string;
  code: string;
  name_he: string;
  description: string | null;
  trigger_event: string;
  trigger_conditions: Record<string, unknown>;
  steps: JourneyStepDef[];
  enabled: boolean;
  allow_concurrent: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface JourneyRunRow {
  id: string;
  definition_id: string;
  definition_code: string;
  contact_id: string;
  current_step: number;
  state: Record<string, unknown>;
  scheduled_next_at: string;
  status: JourneyRunStatus;
  started_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  last_error: string | null;
  // Optional join surface for /journeys listings.
  definition?: { code: string; name_he: string };
}

// Tier 2.B — automation rule catalog. Each row documents one of the
// spec's 19 automations + any custom rules the admin adds later.
// source: 'code' means the rule lives in an edge function today;
// 'engine' means the configurable engine drives it (Tier 4);
// 'planned' marks spec rules not yet implemented.
export type AutomationSource = 'code' | 'engine' | 'planned';
export type AutomationCategory = 'intake' | 'nurture' | 'sales' | 'commission' | 'retention' | 'presale' | 'control' | 'partner';

export interface AutomationRuleRow {
  id: string;
  code: string;
  name_he: string;
  description: string | null;
  trigger_event: string;
  category: AutomationCategory | string;
  enabled: boolean;
  source: AutomationSource;
  implementation_ref: string | null;
  // Tier 4.A — DSL fields. Engine-source rules use these; code/planned
  // rows usually have empty {} and [] respectively.
  conditions: Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Tier 2.C — automation run log.
export type AutomationRunStatus = 'success' | 'skipped' | 'failed' | 'partial';

export interface AutomationRunRow {
  id: string;
  rule_id: string | null;
  rule_code: string;
  trigger_event: string;
  contact_id: string | null;
  context: Record<string, unknown>;
  action_results: Array<Record<string, unknown>>;
  status: AutomationRunStatus;
  reason: string | null;
  duration_ms: number | null;
  correlation_id: string | null;
  created_at: string;
  // Optional join from /automations endpoint.
  rule?: { code: string; name_he: string; category: string };
}

// Tier 2.A — message templates for WhatsApp / SMS / email. The 16
// from spec Appendix C are seeded by migration 062; admins can add
// more via the /templates page. The body uses {{var}} markers that
// the application's render helper expands against context.
export type TemplateChannel = 'whatsapp' | 'sms' | 'email';
export type TemplateStatus = 'draft' | 'active' | 'deprecated';

export interface MessageTemplateRow {
  id: string;
  key: string;
  channel: TemplateChannel;
  name_he: string;
  description: string | null;
  body: string;
  variables_used: string[];
  tags: string[];
  status: TemplateStatus;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Tier 1.D — Commission ledger. One row per partner-mediated deal,
// created automatically by trigger when deals.seriousness_deposit_paid_at
// gets set. status walks pending → to_bill → paid; either of the first
// two can also walk to cancelled.
export type CommissionStatus = 'pending' | 'to_bill' | 'paid' | 'cancelled';

export interface CommissionRow {
  id: string;
  deal_id: string;
  partner_id: string;
  pct_snapshot: number;
  deal_value_snapshot: number;
  amount_due: number;
  currency: string;
  status: CommissionStatus;
  pending_at: string;
  to_bill_at: string | null;
  paid_at: string | null;
  cancelled_at: string | null;
  amount_received: number | null;
  payment_method: string | null;
  payment_reference: string | null;
  cancellation_reason: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // Joined when fetched via /commissions endpoint.
  partners?: { id: string; full_name: string; domain: PartnerDomain };
  deals?: { id: string; track: PrdTrack; value: number | null; status: string };
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
