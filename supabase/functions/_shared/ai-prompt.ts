import type { AiDecisionContext } from './ai-contract.ts';
import type { Playbook } from './playbooks.ts';
import type { PromptOverrides } from './prompt-variant.ts';
import { formatTimeContextForPrompt } from './time-context.ts';
import { resolveMaxReplyChars } from './reply-length.ts';

export const RESPONSE_SCHEMA_HINT = `Return JSON exactly matching this shape (Hebrew for replyText/notesForMia):
{
  "replyText": string|null,
  "intentClassification": string,
  "leadStatusUpdate": string|null,
  "leadHeatUpdate": string|null,
  "scoreDelta": integer,
  "escalateToMia": boolean,
  "escalateToPhoneSales": boolean,
  "createQueueType": string|null,
  "nextActionType": string|null,
  "nextActionDueAt": string|null,
  "notesForMia": string|null,
  "sendMode": "freeform"|"template"|"manual_only"|"no_send",
  "policyFlags": string[]
}`;

export function buildAiSystemPrompt(
  playbook: Playbook,
  ctx: AiDecisionContext,
  overrides: PromptOverrides = {},
): string {
  const product = ctx.runtimeConfig.product;
  const objective = typeof overrides.objective === 'string' && overrides.objective.length > 0
    ? overrides.objective
    : playbook.objective;
  const guidance = Array.isArray(overrides.guidance) && overrides.guidance.length > 0
    ? overrides.guidance
    : playbook.guidance;
  return [
    `You are the Karnaf CRM operator for the Hebrew-speaking digital program "${product.displayName}".`,
    `Channel is WhatsApp. Tone: personal, professional, courteous, never aggressive, no flattery, max one emoji when natural.`,
    `Active playbook: ${playbook.name}. Objective: ${objective}`,
    `Guidance:`,
    ...guidance.map((g) => ` - ${g}`),
    `Forbidden phrases (never produce, paraphrase, or imply): ${[...playbook.forbidden, ...ctx.runtimeConfig.forbiddenClaims].join('; ')}`,
    `Pricing context (do not promise discounts unless instructed): typical ${product.priceTypicalIls} ILS, floor ${product.priceMinIls} ILS.`,
    `Reply length: <= ${resolveMaxReplyChars(ctx.lead.heat, ctx.runtimeConfig.ai.maxReplyChars)} characters (calibrated to lead heat=${ctx.lead.heat}). WhatsApp style: short paragraphs, no markdown headings.`,
    `Allowed lead_status transitions for this turn: ${playbook.allowedNextStatuses.join(', ')}; otherwise leave leadStatusUpdate null.`,
    `Policy flags you may add: free_advice_overflow, partner_block, financial_sensitivity, off_topic, payment_block, after_hours.`,
    `Always return valid JSON. ${RESPONSE_SCHEMA_HINT}`,
  ].join('\n');
}

export function buildAiUserPrompt(ctx: AiDecisionContext): string {
  const recent = ctx.recentMessages
    .slice()
    .reverse()
    .map((m) => `${m.senderType}: ${m.contentText ?? ''}`)
    .join('\n');

  const lines: string[] = [
    `Lead profile:`,
    `  id: ${ctx.lead.id}`,
    `  name: ${ctx.lead.fullName ?? 'unknown'}`,
    `  source: ${ctx.lead.source}`,
    `  sourceDetail: ${ctx.lead.sourceDetail ?? 'none'}`,
    `  sourceCampaign: ${ctx.lead.sourceCampaign ?? 'none'}`,
    `  status: ${ctx.lead.status}`,
    `  heat: ${ctx.lead.heat}`,
    `  score: ${ctx.lead.score}`,
    `  ownership: ${ctx.lead.ownershipMode}`,
    `  paymentStatus: ${ctx.lead.paymentStatus ?? 'none'}`,
    `  partnerInvolved: ${formatTriBool(ctx.lead.partnerInvolved)}`,
    `  freeAdviceCount: ${ctx.freeAdviceCount}`,
    `  priorPhoneCalls: ${ctx.lead.priorPhoneCallCount}${ctx.lead.lastPhoneCallOutcome ? ` (last outcome: ${ctx.lead.lastPhoneCallOutcome})` : ''}`,
    `  lastInboundAt: ${ctx.lead.lastInboundAt ?? 'none'}`,
    `  firstInboundSnippet: ${ctx.lead.firstInboundSnippet ?? '(none)'}`,
    `Conversation summary (older context, condensed):`,
    `  ${ctx.lead.conversationSummary ?? '(none)'}`,
    `Recent messages (oldest -> newest):`,
    recent || '(none)',
  ];

  if (ctx.timeContext) {
    lines.push(`Temporal context:`);
    for (const l of formatTimeContextForPrompt(ctx.timeContext, ctx.runtimeConfig.activeHours.timezone)) {
      lines.push(`  ${l}`);
    }
  } else {
    lines.push(
      `Active hours ${ctx.runtimeConfig.activeHours.start}-${ctx.runtimeConfig.activeHours.end} ${ctx.runtimeConfig.activeHours.timezone}.`,
    );
  }

  if (ctx.recentAiQuestions && ctx.recentAiQuestions.length) {
    lines.push(`Recent AI questions already asked (do not re-ask these unless the lead explicitly invites re-asking):`);
    for (const q of ctx.recentAiQuestions) lines.push(`  - ${q}`);
  }

  lines.push(`Decide the next CRM action and the next WhatsApp reply. Return JSON only.`);
  return lines.join('\n');
}

function formatTriBool(v: boolean | null): string {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return 'unknown';
}
