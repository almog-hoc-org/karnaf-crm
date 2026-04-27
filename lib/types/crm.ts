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

export type QueueType =
  | 'first_response_due'
  | 'hot_lead'
  | 'sla_risk'
  | 'human_handoff'
  | 'payment_pending'
  | 'phone_escalation'
  | 'nurture_due'
  | 'dormant_review'
  | 'failed_automation'
  | 'weekend_carryover'
  | 'low_fit_cleanup';

export interface LeadRecord {
  id: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  source: string;
  sourceDetail: string | null;
  status: LeadStatus;
  heat: LeadHeat;
  ownershipMode: OwnershipMode;
  score: number;
  nextActionType: string | null;
  nextActionDueAt: string | null;
  paymentStatus: string | null;
  doNotContact: boolean;
  removedByRequest: boolean;
}

export interface MessageRecord {
  id: string;
  leadId: string;
  conversationId: string;
  senderType: 'lead' | 'ai' | 'mia' | 'sales_rep' | 'system';
  direction: 'inbound' | 'outbound' | 'internal';
  messageType: 'text' | 'media' | 'template' | 'system_event';
  contentText: string | null;
  providerStatus: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | null;
  createdAt: string;
}

export interface QueueRecord {
  id: string;
  leadId: string;
  queueType: QueueType;
  priorityLevel: number;
  status: 'pending' | 'claimed' | 'resolved' | 'canceled';
  dueAt: string | null;
  reason: string | null;
}
