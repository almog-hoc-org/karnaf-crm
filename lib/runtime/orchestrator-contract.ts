import type { LeadHeat, LeadStatus } from '../types/crm';

export interface OrchestratorContext {
  leadId: string;
  phone: string;
  source: string;
  leadStatus: LeadStatus;
  leadHeat: LeadHeat;
  conversationSummary: string | null;
  recentMessages: Array<{
    senderType: string;
    contentText: string | null;
    createdAt: string;
  }>;
  workingHours: {
    start: string;
    end: string;
    timezone: string;
  };
}

export interface OrchestratorDecision {
  replyText: string | null;
  intentClassification: string;
  leadStatusUpdate: LeadStatus | null;
  leadHeatUpdate: LeadHeat | null;
  scoreDelta: number;
  escalateToMia: boolean;
  escalateToPhoneSales: boolean;
  createQueueType: string | null;
  nextActionType: string | null;
  nextActionDueAt: string | null;
  tagsToAdd: string[];
  notesForMia: string | null;
  sendMode: 'freeform' | 'template' | 'manual_only' | 'no_send';
}
