import type { LeadRecord, QueueRecord } from '../types/crm';

export interface DashboardSummary {
  leadsToday: number;
  unansweredNow: number;
  hotLeadsNow: number;
  paymentPendingNow: number;
  slaRiskCount: number;
  queueCounts: Record<string, number>;
}

export function buildDashboardSummary(input: {
  leads: LeadRecord[];
  queueItems: QueueRecord[];
}): DashboardSummary {
  const queueCounts: Record<string, number> = {};
  for (const item of input.queueItems) {
    queueCounts[item.queueType] = (queueCounts[item.queueType] || 0) + 1;
  }

  return {
    leadsToday: input.leads.length,
    unansweredNow: input.leads.filter((lead) => lead.status === 'new' || lead.status === 'first_contact_sent').length,
    hotLeadsNow: input.leads.filter((lead) => lead.heat === 'hot').length,
    paymentPendingNow: input.leads.filter((lead) => lead.paymentStatus === 'paid' || lead.status === 'payment_pending').length,
    slaRiskCount: queueCounts['sla_risk'] || 0,
    queueCounts,
  };
}
