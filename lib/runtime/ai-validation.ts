// Pure validation logic mirrored from supabase/functions/_shared/ai-validation.ts.
// Both files must stay in sync; the duplication exists because Deno and Node
// modules can't share file paths in this monorepo.

import { canTransition } from './state-machine';
import { containsForbiddenClaim } from './forbidden-claims';

export type SendMode = 'freeform' | 'template' | 'manual_only' | 'no_send';

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

export interface PlaybookRef {
  name: string;
  forbidden: string[];
  allowedNextStatuses: string[];
}

export interface ValidationInput {
  output: AiDecisionOutput;
  currentStatus: string;
  forbiddenClaims: string[];
  playbook: PlaybookRef;
  maxReplyChars: number;
  isDoNotContact: boolean;
  isRemovedByRequest: boolean;
}

export interface ValidationResult {
  output: AiDecisionOutput;
  flags: string[];
}

const ALLOWED_STATUSES = new Set([
  'new', 'first_contact_sent', 'responded', 'qualified', 'nurture',
  'checkout_pushed', 'payment_pending', 'human_handoff', 'won', 'lost',
  'dormant', 'onboarding_active', 'active_student', 'do_not_contact',
  'removed_by_request', 'duplicate', 'manual_review_required',
]);

const ALLOWED_HEATS = new Set(['hot', 'warm', 'cool', 'cold']);
const ALLOWED_SEND_MODES = new Set<SendMode>(['freeform', 'template', 'manual_only', 'no_send']);
const ALLOWED_QUEUES = new Set([
  'first_response_due', 'hot_lead', 'sla_risk', 'human_handoff',
  'payment_pending', 'phone_escalation', 'nurture_due', 'dormant_review',
  'failed_automation', 'weekend_carryover', 'low_fit_cleanup',
  'manual_review_required',
]);

export function validateAiDecision(input: ValidationInput): ValidationResult {
  const flags: string[] = [];
  const out: AiDecisionOutput = { ...input.output };

  if (input.isDoNotContact || input.isRemovedByRequest) {
    out.replyText = null;
    out.sendMode = 'no_send';
    flags.push('suppressed_dnc');
  }

  if (out.leadStatusUpdate) {
    if (!ALLOWED_STATUSES.has(out.leadStatusUpdate)) {
      flags.push('status_not_allowed_value');
      out.leadStatusUpdate = null;
    } else if (!canTransition(input.currentStatus, out.leadStatusUpdate)) {
      flags.push('status_transition_illegal');
      out.leadStatusUpdate = null;
    } else if (!input.playbook.allowedNextStatuses.includes(out.leadStatusUpdate)) {
      flags.push('status_outside_playbook');
      out.leadStatusUpdate = null;
    }
  }

  if (out.leadHeatUpdate && !ALLOWED_HEATS.has(out.leadHeatUpdate)) {
    flags.push('heat_invalid');
    out.leadHeatUpdate = null;
  }

  out.scoreDelta = Number.isFinite(out.scoreDelta) ? Math.max(-25, Math.min(25, Math.trunc(out.scoreDelta))) : 0;

  if (out.createQueueType && !ALLOWED_QUEUES.has(out.createQueueType)) {
    flags.push('queue_invalid');
    out.createQueueType = null;
  }

  if (!ALLOWED_SEND_MODES.has(out.sendMode)) {
    flags.push('send_mode_invalid');
    out.sendMode = 'no_send';
  }

  out.replyText = sanitizeReply(out.replyText, input.maxReplyChars);

  if (out.replyText) {
    const hit = containsForbiddenClaim(out.replyText, input.forbiddenClaims) ||
      containsForbiddenClaim(out.replyText, input.playbook.forbidden);
    if (hit) {
      flags.push(`forbidden_claim:${hit}`);
      out.replyText = null;
      out.sendMode = 'no_send';
    }
  }

  if (out.escalateToPhoneSales) {
    out.createQueueType = 'phone_escalation';
    if (!out.notesForMia) out.notesForMia = 'Phone escalation requested.';
  } else if (out.escalateToMia && !out.createQueueType) {
    out.createQueueType = 'human_handoff';
  }

  if (!out.replyText && (out.sendMode === 'freeform' || out.sendMode === 'template')) {
    out.sendMode = 'no_send';
    flags.push('no_send_no_text');
  }

  out.policyFlags = Array.from(new Set([...(out.policyFlags || []), ...flags]));
  out.playbookName = input.playbook.name;
  return { output: out, flags };
}

function sanitizeReply(reply: string | null, maxChars: number): string | null {
  if (!reply) return null;
  let trimmed = reply.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.includes('"replyText"')) return null;
  if (trimmed.length > maxChars) trimmed = trimmed.slice(0, maxChars);
  return trimmed;
}
