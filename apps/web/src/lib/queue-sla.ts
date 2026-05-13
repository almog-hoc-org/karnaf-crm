// SLA target (minutes from queue item creation) per queue_type. Items
// older than the target render red; items older than half the target
// render amber; younger items render neutral.
export const QUEUE_SLA_MINUTES: Record<string, number> = {
  first_response_due: 30,
  hot_lead: 60,
  sla_risk: 0,
  human_handoff: 120,
  payment_pending: 24 * 60,
  phone_escalation: 4 * 60,
  nurture_due: 8 * 60,
  dormant_review: 48 * 60,
  failed_automation: 60,
  weekend_carryover: 12 * 60,
  low_fit_cleanup: 24 * 60,
  manual_review_required: 4 * 60,
};

export type SlaState = 'overdue' | 'warning' | 'ok';

export interface SlaResult {
  state: SlaState;
  ageMinutes: number | null;
  targetMinutes: number | null;
}

export function computeSlaState(
  queueType: string,
  createdAt: string | null | undefined,
  nowMs: number = Date.now(),
): SlaResult {
  if (!createdAt) return { state: 'ok', ageMinutes: null, targetMinutes: null };
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return { state: 'ok', ageMinutes: null, targetMinutes: null };
  const ageMinutes = Math.max(0, Math.floor((nowMs - created) / 60000));
  const target = QUEUE_SLA_MINUTES[queueType] ?? null;
  if (target === null) return { state: 'ok', ageMinutes, targetMinutes: null };
  if (ageMinutes >= target) return { state: 'overdue', ageMinutes, targetMinutes: target };
  if (ageMinutes >= Math.floor(target * 0.5)) return { state: 'warning', ageMinutes, targetMinutes: target };
  return { state: 'ok', ageMinutes, targetMinutes: target };
}

export function slaRowClass(state: SlaState): string {
  if (state === 'overdue') return 'kf-row-overdue';
  if (state === 'warning') return 'kf-row-warning';
  return '';
}
