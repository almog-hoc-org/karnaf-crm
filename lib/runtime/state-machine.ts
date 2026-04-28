// Lead status state machine. Mirrored across Node (this file) and Deno
// (supabase/functions/_shared/state-machine.ts). Keep in sync.

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

const transitions: Record<LeadStatus, LeadStatus[]> = {
  new: ['first_contact_sent', 'manual_review_required', 'do_not_contact', 'removed_by_request'],
  first_contact_sent: ['responded', 'nurture', 'human_handoff', 'lost', 'do_not_contact', 'removed_by_request'],
  responded: ['qualified', 'nurture', 'checkout_pushed', 'human_handoff', 'lost', 'do_not_contact', 'removed_by_request'],
  qualified: ['checkout_pushed', 'human_handoff', 'lost', 'do_not_contact', 'removed_by_request'],
  nurture: ['responded', 'qualified', 'dormant', 'lost', 'do_not_contact', 'removed_by_request'],
  checkout_pushed: ['payment_pending', 'won', 'human_handoff', 'lost', 'do_not_contact', 'removed_by_request'],
  payment_pending: ['won', 'human_handoff', 'lost', 'do_not_contact', 'removed_by_request'],
  human_handoff: ['responded', 'qualified', 'checkout_pushed', 'payment_pending', 'won', 'lost', 'do_not_contact', 'removed_by_request'],
  won: ['onboarding_active', 'active_student'],
  lost: ['nurture', 'dormant'],
  dormant: ['responded', 'nurture', 'lost'],
  onboarding_active: ['active_student'],
  active_student: [],
  do_not_contact: [],
  removed_by_request: [],
  duplicate: [],
  manual_review_required: ['first_contact_sent', 'human_handoff', 'lost', 'do_not_contact'],
};

export function canTransition(from: string, to: string): boolean {
  const allowed = transitions[from as LeadStatus];
  if (!allowed) return false;
  return allowed.includes(to as LeadStatus);
}

export function assertTransition(from: LeadStatus, to: LeadStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid lead status transition: ${from} -> ${to}`);
  }
}
