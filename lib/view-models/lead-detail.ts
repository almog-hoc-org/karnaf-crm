import type { LeadRecord, MessageRecord, QueueRecord } from '../types/crm';

export interface LeadDetailViewModel {
  lead: LeadRecord;
  transcript: MessageRecord[];
  queueItems: QueueRecord[];
  latestInboundText: string | null;
  latestOutboundText: string | null;
}

export function buildLeadDetailViewModel(input: {
  lead: LeadRecord;
  transcript: MessageRecord[];
  queueItems: QueueRecord[];
}): LeadDetailViewModel {
  const latestInbound = [...input.transcript].reverse().find((m) => m.direction === 'inbound' && !!m.contentText);
  const latestOutbound = [...input.transcript].reverse().find((m) => m.direction === 'outbound' && !!m.contentText);

  return {
    lead: input.lead,
    transcript: input.transcript,
    queueItems: input.queueItems,
    latestInboundText: latestInbound?.contentText || null,
    latestOutboundText: latestOutbound?.contentText || null,
  };
}
