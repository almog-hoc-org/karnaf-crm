import type { LeadRecord } from '../types/crm';

export interface LeadsListViewModel {
  total: number;
  hotCount: number;
  humanOwnedCount: number;
  leads: LeadRecord[];
}

export function buildLeadsListViewModel(leads: LeadRecord[]): LeadsListViewModel {
  return {
    total: leads.length,
    hotCount: leads.filter((lead) => lead.heat === 'hot').length,
    humanOwnedCount: leads.filter((lead) => lead.ownershipMode !== 'ai_active').length,
    leads,
  };
}
