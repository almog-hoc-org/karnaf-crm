// Shared AI input/output contract. The decision service receives a
// pre-assembled context, picks a playbook, calls the model, validates the
// structured output, and returns a contract-shaped action object the
// orchestrator executes.

export type SendMode = 'freeform' | 'template' | 'manual_only' | 'no_send';

export interface AiLeadContext {
  id: string;
  fullName: string | null;
  phone: string | null;
  source: string;
  sourceDetail: string | null;
  sourceCampaign: string | null;
  status: string;
  heat: string;
  score: number;
  ownershipMode: string;
  paymentStatus: string | null;
  partnerInvolved: boolean | null;
  doNotContact: boolean;
  removedByRequest: boolean;
  conversationSummary: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  priorPhoneCallCount: number;
  lastPhoneCallOutcome: string | null;
  firstInboundSnippet: string | null;
  topicsTouched: TopicEntry[];
}

export interface TopicEntry {
  topic: string;
  count: number;
  last_at: string;
}

export interface AiRecentMessage {
  senderType: string;
  contentText: string | null;
  createdAt: string;
}

export interface AiRuntimeConfig {
  activeHours: { start: string; end: string; timezone: string };
  followUpDelays: { firstResponseMinutes: number; nurtureHours: number; paymentPendingHours: number };
  product: { code: string; displayName: string; priceMinIls: number; priceTypicalIls: number };
  forbiddenClaims: string[];
  ai: { model: string; promptVersion: string; maxReplyChars: number };
}

export interface AiTimeContext {
  currentTimeIso: string;
  dayOfWeek: string;
  isBusinessHours: boolean;
  isAfterHours: boolean;
  isWeekend: boolean;
  minutesSinceLastInbound: number | null;
  idleBucket: 'fresh' | 'short' | 'medium' | 'long' | 'cold' | null;
}

export interface AiPersonaContext {
  persona: 'analyst' | 'impulsive' | 'skeptical' | 'delegator' | 'unknown';
  guidance: string[];
  signals?: {
    message_count: number;
    avg_message_length: number;
    short_count: number;
    verbose_count: number;
    question_count: number;
    skeptic_hits: number;
    hesitation_hits: number;
    delegator_hits: number;
  };
}

export interface AiIntentContext {
  intent: 'question' | 'objection' | 'buy_signal' | 'escalation_request' | 'chit_chat' | 'dnc_request' | 'unclear';
  sentiment: 'positive' | 'neutral' | 'frustrated' | 'confused';
  confidence: 'high' | 'medium' | 'low';
  matchedKeywords?: string[];
}

export interface AiAuthorisedClaim {
  claim_type: string;
  hebrew_text: string;
  weight: number;
}

export interface AiDecisionContext {
  lead: AiLeadContext;
  recentMessages: AiRecentMessage[];
  runtimeConfig: AiRuntimeConfig;
  freeAdviceCount: number;
  timeContext?: AiTimeContext;
  recentAiQuestions?: string[];
  personaContext?: AiPersonaContext;
  intentContext?: AiIntentContext;
  authorisedClaims?: AiAuthorisedClaim[];
}

export interface AiDecisionOutput {
  replyText: string | null;
  intentClassification: string;
  leadStatusUpdate: string | null;
  leadHeatUpdate: string | null;
  scoreDelta: number;
  escalateToMia: boolean;
  escalateToPhoneSales: boolean;
  createQueueType: string | null;
  nextActionType: string | null;
  nextActionDueAt: string | null;
  notesForMia: string | null;
  sendMode: SendMode;
  policyFlags: string[];
  playbookName: string;
}
