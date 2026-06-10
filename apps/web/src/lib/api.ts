import { supabase } from './supabase';
import type {
  ActivityRow,
  AttentionRow,
  CommissionRow,
  ConversationRow,
  DashboardSummary,
  DealRow,
  EventRow,
  IntakeSegment,
  InquiryType,
  LeadDetail,
  LeadFit,
  LeadHeat,
  LeadRow,
  MeetingRow,
  MessageRow,
  PartnerDomain,
  PartnerRow,
  PartnerWorkloadRow,
  ProductInterest,
  ProgramMemberRow,
  ProjectFundingRow,
  ProjectRow,
  ProjectType,
  QueueRow,
  ReadinessLevel,
  TaskRow,
} from './types';

const baseUrl = import.meta.env.VITE_FUNCTIONS_BASE_URL || '/functions/v1';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError(401, 'Not signed in');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'x-correlation-id': crypto.randomUUID(),
  };
}

async function getJson<T>(
  path: string,
  params?: Record<string, string | number | undefined> | object,
): Promise<T> {
  const url = new URL(`${baseUrl}${path}`, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const headers = await authHeaders();
  const res = await fetch(url.toString().replace(window.location.origin, ''), { headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed: ${res.status}`, body);
  return body as T;
}

async function postJson<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed: ${res.status}`, body);
  return body as T;
}

// === Reads ================================================================

export async function fetchDashboardSummary() {
  const r = await getJson<{ ok: true; summary: DashboardSummary }>('/dashboard-summary');
  return r.summary;
}

export interface LeadsListParams {
  status?: string;
  heat?: string;
  ownershipMode?: string;
  source?: string;
  search?: string;
  searchIn?: 'lead' | 'messages';
  createdFrom?: string;
  createdTo?: string;
  inboundFrom?: string;
  limit?: number;
  offset?: number;
}
export async function fetchLeadsList(params: LeadsListParams = {}) {
  const r = await getJson<{
    ok: true;
    leads: LeadRow[];
    total: number | null;
    limit: number;
    offset: number;
  }>('/leads-list', params);
  return { leads: r.leads, total: r.total, limit: r.limit, offset: r.offset };
}

export interface HumanOwnerProfile {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string | null;
}

export async function fetchLeadDetail(leadId: string) {
  return getJson<{
    ok: true;
    lead: LeadDetail;
    conversations: ConversationRow[];
    messages: MessageRow[];
    queueItems: QueueRow[];
    tasks: TaskRow[];
    events: EventRow[];
    deals?: DealRow[];
    meetings?: MeetingRow[];
    programMember?: ProgramMemberRow | null;
    // Tier 0.A — unified activity feed (will replace the 4 legacy arrays
    // once Tier 0.F lands the new Universal Record Screen). Marked optional
    // for the one release that the old + new endpoints coexist.
    activities?: ActivityRow[];
    humanOwnerProfile: HumanOwnerProfile | null;
  }>('/lead-detail', { leadId });
}

export async function fetchQueueList(params: { queueType?: string; status?: string } = {}) {
  const r = await getJson<{ ok: true; queueItems: QueueRow[] }>('/queue-list', params);
  return r.queueItems;
}

export async function fetchAttentionInbox(limit?: number) {
  const r = await getJson<{ ok: true; items: AttentionRow[] }>(
    '/attention-inbox',
    limit ? { limit } : undefined,
  );
  return r.items;
}

// === Partners (Tier 1.A) ==================================================

export async function fetchPartners() {
  return getJson<{ ok: true; partners: PartnerRow[]; workload: PartnerWorkloadRow[] }>('/partners');
}

export type PartnerAction =
  | { action: 'create'; full_name: string; phone?: string | null; email?: string | null;
      domain: PartnerDomain; commission_to_karnaf_pct?: number; notes?: string | null }
  | { action: 'update'; id: string; full_name?: string; phone?: string | null; email?: string | null;
      domain?: PartnerDomain; commission_to_karnaf_pct?: number; notes?: string | null }
  | { action: 'archive' | 'restore' | 'pause'; id: string };

export async function postPartnerAction(payload: PartnerAction) {
  return postJson<{ ok: true; partner: PartnerRow }>('/partners', payload as unknown as Record<string, unknown>);
}

// === Projects (Tier 1.B) ==================================================

export async function fetchProjects() {
  return getJson<{ ok: true; projects: ProjectRow[]; funding: ProjectFundingRow[] }>('/projects');
}

export type ProjectAction =
  | { action: 'create'; name: string; city?: string | null; developer_name?: string | null;
      project_type?: ProjectType; total_units?: number | null; price_per_unit?: number | null;
      target_amount?: number | null; target_date?: string | null; notes?: string | null }
  | { action: 'update'; id: string; name?: string; city?: string | null; developer_name?: string | null;
      project_type?: ProjectType; total_units?: number | null; price_per_unit?: number | null;
      target_amount?: number | null; target_date?: string | null; notes?: string | null }
  | { action: 'close' | 'cancel' | 'mark_executed' | 'reopen'; id: string };

export async function postProjectAction(payload: ProjectAction) {
  return postJson<{ ok: true; project: ProjectRow }>('/projects', payload as unknown as Record<string, unknown>);
}

// === Commissions (Tier 1.D) ===============================================

export async function fetchCommissions(status?: 'pending' | 'to_bill' | 'paid' | 'cancelled') {
  return getJson<{ ok: true; commissions: CommissionRow[] }>('/commissions', status ? { status } : undefined);
}

export type CommissionAction =
  | { action: 'mark_paid'; id: string; amount_received?: number; payment_method?: string;
      payment_reference?: string; notes?: string }
  | { action: 'cancel'; id: string; cancellation_reason: string };

export async function postCommissionAction(payload: CommissionAction) {
  return postJson<{ ok: true; commission: CommissionRow }>('/commissions', payload as unknown as Record<string, unknown>);
}

// === Writes ===============================================================

export type AdminAction =
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

export type ReopenTarget = 'responded' | 'qualified' | 'nurture' | 'human_handoff';

export type CallOutcome = 'connected' | 'no_answer' | 'voicemail' | 'declined' | 'callback_requested';

export interface LeadMetaUpdates {
  goal_summary?: string | null;
  pain_point_summary?: string | null;
  main_blocker?: string | null;
  next_action_type?: string | null;
  // Operator-editable identity/context — added 2026-05-15 for Mia's day-to-day
  // edits. Phone is intentionally excluded (it's the routing key).
  full_name?: string | null;
  email?: string | null;
  city?: string | null;
  decision_context?: string | null;
  lost_reason?: string | null;
  lead_heat?: LeadHeat | null;
  lead_fit?: LeadFit | null;
  readiness_level?: ReadinessLevel | null;
  inquiry_type?: InquiryType | null;
  product_interest?: ProductInterest | null;
  intake_segment?: IntakeSegment | null;
  primary_track?: 'program' | 'presale' | 'investor_mentorship' | null;
  interest_topic?: string | null;
}

export async function postAdminAction(payload: {
  action: AdminAction;
  leadId?: string;
  conversationId?: string | null;
  queueItemId?: string;
  note?: string | null;
  targetStatus?: ReopenTarget;
  dealId?: string | null;
  targetStage?: string;
  callOutcome?: CallOutcome;
  callDurationMinutes?: number;
  meetingType?: MeetingRow['meeting_type'];
  meetingStartsAt?: string;
  meetingEndsAt?: string | null;
  meetingSummary?: string | null;
  meetingUrl?: string | null;
  meetingId?: string;
  meetingStatus?: MeetingRow['status'];
  metaUpdates?: LeadMetaUpdates;
}) {
  return postJson<{ ok: true; action: string }>('/admin-actions', payload);
}

export async function postSendReply(payload: { leadId: string; conversationId: string; text: string }) {
  return postJson<{ ok: true; mode: string; queued?: boolean; pendingReplyId?: string; warning?: string }>('/send-reply', payload);
}

export async function postQueueResolve(payload: { queueItemId: string; resolutionNote?: string | null }) {
  return postJson<{ ok: true }>('/queue-resolve', payload);
}

export type BulkLeadAction = 'assign_owner' | 'change_heat';

export interface BulkLeadActionPayload {
  action: BulkLeadAction;
  leadIds: string[];
  assigneeUserId?: string;
  heat?: 'hot' | 'warm' | 'cool' | 'cold';
}

export async function postBulkLeadAction(payload: BulkLeadActionPayload) {
  return postJson<{ ok: true; updated: number }>('/bulk-lead-actions', { ...payload });
}

// === Analytics ============================================================

export interface SourcePerformanceRow {
  source: string;
  leads_total: number;
  leads_engaged: number;
  leads_qualified: number;
  leads_checkout_pushed: number;
  leads_won: number;
  leads_lost: number;
  win_rate_pct: number;
}

export interface AgingBucket {
  count: number;
  avgMinutes: number;
  maxMinutes: number;
}

export interface AiVsHumanRow {
  touch_pattern: string;
  lead_status: string;
  leads_count: number;
}

export interface RecentActivityRow {
  id: string;
  lead_id: string;
  event_type: string;
  actor_type: string;
  created_at: string;
  full_name: string | null;
  phone: string | null;
  lead_status: string;
  lead_heat: string;
}

export interface PromptVariantOutcome {
  prompt_version: string;
  playbook_name: string;
  decisions_total: number;
  success_total: number;
  blocked_total: number;
  leads_touched: number;
  leads_won: number;
  leads_lost: number;
}

export interface LeadCohortRow {
  cohort_week: string;
  source: string;
  leads_total: number;
  responded: number;
  qualified: number;
  checkout_pushed: number;
  won: number;
  lost: number;
  win_rate_pct: number;
  avg_minutes_to_win: number;
}

export interface FirstResponseTimeRow {
  source: string;
  measured_leads: number;
  p50_minutes: number;
  p90_minutes: number;
  max_minutes: number;
  unanswered_leads: number;
}

export async function fetchAnalyticsSummary() {
  return getJson<{
    ok: true;
    sourcePerformance: SourcePerformanceRow[];
    aging: Record<string, AgingBucket>;
    recentActivity: RecentActivityRow[];
    aiVsHuman: AiVsHumanRow[];
    promptVariants: PromptVariantOutcome[];
    cohorts: LeadCohortRow[];
    firstResponseTimes: FirstResponseTimeRow[];
  }>('/analytics-summary');
}

// === Users management =====================================================

export interface ProfileRow {
  id: string;
  email: string | null;
  full_name: string | null;
  role: 'owner' | 'admin' | 'mia' | 'sales_rep' | 'viewer';
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export async function fetchUsersList() {
  const r = await getJson<{ ok: true; profiles: ProfileRow[] }>('/users-manage');
  return r.profiles;
}

export async function postCreateUser(payload: {
  email: string;
  password: string;
  role: ProfileRow['role'];
  fullName?: string | null;
}) {
  return postJson<{ ok: true; profile: ProfileRow }>('/users-manage', { action: 'create', ...payload });
}

export async function postUpdateUser(payload: {
  userId: string;
  role?: ProfileRow['role'];
  isActive?: boolean;
  fullName?: string | null;
}) {
  return postJson<{ ok: true; profile: ProfileRow }>('/users-manage', { action: 'update', ...payload });
}

export interface TeamMember {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: ProfileRow['role'];
  is_active: boolean;
  active_leads_owned: number;
  recent_touches_7d: number;
  last_active_at: string | null;
}

export async function fetchTeamWorkload() {
  const r = await getJson<{ ok: true; members: TeamMember[] }>('/team-workload');
  return r.members;
}

export interface LeadSource {
  slug: string;
  display_name: string;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  intake_source_contracts?: IntakeSourceContract[];
}

export interface IntakeSourceContract {
  contract_key: string;
  display_name: string;
  default_track: string | null;
  default_stage: string | null;
  required_fields: string[];
  is_active: boolean;
}

export async function fetchLeadSources() {
  const r = await getJson<{ ok: true; sources: LeadSource[] }>('/lead-sources');
  return r.sources;
}

export async function postCreateLeadSource(payload: {
  slug: string;
  display_name: string;
  sort_order?: number;
}) {
  return postJson<{ ok: true; source: LeadSource }>('/lead-sources', { action: 'create', ...payload });
}

export async function postUpdateLeadSource(payload: {
  slug: string;
  display_name?: string;
  is_active?: boolean;
  sort_order?: number;
}) {
  return postJson<{ ok: true; source: LeadSource }>('/lead-sources', { action: 'update', ...payload });
}

export async function postDeleteLeadSource(slug: string) {
  return postJson<{ ok: true }>('/lead-sources', { action: 'delete', slug });
}

// === WhatsApp router options =============================================

export type WhatsAppRouterTrack = 'program' | 'presale' | 'investor_mentorship' | 'human';

export interface WhatsAppRouterOption {
  option_key: string;
  display_order: number;
  label_he: string;
  match_terms: string[];
  track: WhatsAppRouterTrack;
  stage: string | null;
  interest_topic: string | null;
  presale_project: string | null;
  is_active: boolean;
  updated_at: string;
}

export interface WhatsAppRouterOptionEvent {
  id: string;
  option_key: string | null;
  action: 'create' | 'update' | 'delete';
  actor_user_id: string | null;
  before_value: Partial<WhatsAppRouterOption> | null;
  after_value: Partial<WhatsAppRouterOption> | null;
  changed_fields: string[];
  created_at: string;
}

export async function fetchWhatsAppRouterOptions() {
  const r = await getJson<{ ok: true; options: WhatsAppRouterOption[] }>('/whatsapp-router-options');
  return r.options;
}

export async function fetchWhatsAppRouterOptionEvents(limit = 50) {
  const r = await getJson<{ ok: true; events: WhatsAppRouterOptionEvent[] }>(`/whatsapp-router-options?audit=1&limit=${limit}`);
  return r.events;
}

export async function postCreateWhatsAppRouterOption(payload: {
  option_key: string;
  display_order?: number;
  label_he: string;
  match_terms?: string[];
  track: WhatsAppRouterTrack;
  stage?: string | null;
  interest_topic?: string | null;
  presale_project?: string | null;
  is_active?: boolean;
}) {
  return postJson<{ ok: true; option: WhatsAppRouterOption }>('/whatsapp-router-options', { action: 'create', ...payload });
}

export async function postUpdateWhatsAppRouterOption(payload: {
  option_key: string;
  display_order?: number;
  label_he?: string;
  match_terms?: string[];
  track?: WhatsAppRouterTrack;
  stage?: string | null;
  interest_topic?: string | null;
  presale_project?: string | null;
  is_active?: boolean;
}) {
  return postJson<{ ok: true; option: WhatsAppRouterOption }>('/whatsapp-router-options', { action: 'update', ...payload });
}

export async function postDeleteWhatsAppRouterOption(optionKey: string) {
  return postJson<{ ok: true }>('/whatsapp-router-options', { action: 'delete', option_key: optionKey });
}

// === Runtime config ======================================================

export interface ActiveHoursConfig {
  start: string;
  end: string;
  timezone: 'Asia/Jerusalem';
  workingDays: number[];
}

export interface WhatsAppSessionConfig {
  freeformWindowHours: number;
  fallbackTemplateName: string;
  templateConfigured: boolean;
  templateApprovalRequired: boolean;
}

export async function fetchRuntimeConfig() {
  return getJson<{ ok: true; activeHours: ActiveHoursConfig; whatsappSession: WhatsAppSessionConfig }>('/runtime-config');
}

export async function postUpdateActiveHours(payload: ActiveHoursConfig) {
  return postJson<{ ok: true; activeHours: ActiveHoursConfig }>('/runtime-config', { action: 'update_active_hours', ...payload });
}

// === Prompt variants =====================================================

export type PlaybookName =
  | 'first_contact_whatsapp_inbound'
  | 'first_contact_form_lead'
  | 'qualification'
  | 'price_objection'
  | 'free_advice_boundary'
  | 'checkout_push'
  | 'payment_pending_rescue'
  | 'phone_request'
  | 'opt_out';

export interface LeadSegmentFilter {
  heat?: string[];
  source?: string[];
  status?: string[];
}

export interface PromptVariantRow {
  id: string;
  playbook_name: PlaybookName;
  version: string;
  weight: number;
  prompt_overrides: { objective?: string; guidance?: string[]; [key: string]: unknown };
  is_active: boolean;
  notes: string | null;
  lead_segment_filter?: LeadSegmentFilter;
  created_at: string;
  updated_at: string;
}

async function deleteJson<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  return postJson<T>(path, payload);
}

export async function fetchPromptVariants() {
  const r = await getJson<{ ok: true; variants: PromptVariantRow[] }>('/prompt-variants');
  return r.variants;
}

export async function postCreatePromptVariant(payload: {
  playbook_name: PlaybookName;
  version: string;
  weight: number;
  prompt_overrides?: PromptVariantRow['prompt_overrides'];
  is_active?: boolean;
  notes?: string | null;
  lead_segment_filter?: LeadSegmentFilter;
}) {
  return postJson<{ ok: true; variant: PromptVariantRow }>('/prompt-variants', {
    action: 'create',
    ...payload,
  });
}

export async function postUpdatePromptVariant(payload: {
  id: string;
  weight?: number;
  prompt_overrides?: PromptVariantRow['prompt_overrides'];
  is_active?: boolean;
  notes?: string | null;
  lead_segment_filter?: LeadSegmentFilter;
}) {
  return postJson<{ ok: true; variant: PromptVariantRow }>('/prompt-variants', {
    action: 'update',
    ...payload,
  });
}

export async function postDeletePromptVariant(id: string) {
  return deleteJson<{ ok: true }>('/prompt-variants', { action: 'delete', id });
}
