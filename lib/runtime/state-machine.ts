import type { LeadStatus } from '../types/crm.js';

const allowedTransitions: Record<LeadStatus, LeadStatus[]> = {
  new: ['first_contact_sent', 'manual_review_required', 'do_not_contact', 'removed_by_request'],
  first_contact_sent: ['responded', 'nurture', 'human_handoff', 'lost', 'do_not_contact', 'removed_by_request'],
  responded: ['qualified', 'nurture', 'human_handoff', 'lost', 'do_not_contact', 'removed_by_request'],
  qualified: ['checkout_pushed', 'human_handoff', 'lost', 'do_not_contact', 'removed_by_request'],
  nurture: ['responded', 'qualified', 'dormant', 'lost', 'do_not_contact', 'removed_by_request'],
  checkout_pushed: ['payment_pending', 'won', 'human_handoff', 'lost', 'do_not_contact', 'removed_by_request'],
  payment_pending: ['won', 'human_handoff', 'lost', 'do_not_contact', 'removed_by_request'],
  human_handoff: ['qualified', 'checkout_pushed', 'payment_pending', 'won', 'lost', 'do_not_contact', 'removed_by_request'],
  won: ['onboarding_active', 'active_student'],
  lost: ['nurture', 'dormant'],
  dormant: ['responded', 'nurture', 'lost'],
  onboarding_active: ['active_student'],
  active_student: [],
  do_not_contact: [],
  removed_by_request: [],
  duplicate: [],
  manual_review_required: ['first_contact_sent', 'human_handoff', 'lost', 'do_not_contact']
};

export function canTransition(from: LeadStatus, to: LeadStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertTransition(from: LeadStatus, to: LeadStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid lead status transition: ${from} -> ${to}`);
  }
}
