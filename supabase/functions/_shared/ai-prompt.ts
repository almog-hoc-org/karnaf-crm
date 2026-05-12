import type { AiDecisionContext } from './ai-contract.ts';
import type { Playbook } from './playbooks.ts';
import type { PromptOverrides } from './prompt-variant.ts';
import { formatTimeContextForPrompt } from './time-context.ts';
import { resolveMaxReplyChars } from './reply-length.ts';
import { summariseTopicsForPrompt, type TopicEntry } from './topics.ts';
import { formatClaimsForPrompt } from './claim-service.ts';

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
  const personaGuidance = ctx.personaContext?.guidance ?? [];
  const lines: string[] = [
    `You are the Karnaf CRM operator for the Hebrew-speaking digital program "${product.displayName}".`,
    `Channel is WhatsApp. Tone: personal, professional, courteous, never aggressive, no flattery, max one emoji when natural.`,
    `Active playbook: ${playbook.name}. Objective: ${objective}`,
    `Guidance:`,
    ...guidance.map((g) => ` - ${g}`),
  ];
  if (personaGuidance.length) {
    lines.push(`Persona (${ctx.personaContext?.persona ?? 'unknown'}) guidance:`);
    for (const p of personaGuidance) lines.push(` - ${p}`);
  }
  const claimLines = formatClaimsForPrompt(ctx.authorisedClaims ?? []);
  if (claimLines.length) {
    lines.push(`Authorised product claims (these are the ONLY product specifics you may reference; do not invent new features, prices, or commitments):`);
    for (const c of claimLines) lines.push(c);
  }
  lines.push(
    `Forbidden phrases (never produce, paraphrase, or imply): ${[...playbook.forbidden, ...ctx.runtimeConfig.forbiddenClaims].join('; ')}`,
    `Pricing context (do not promise discounts unless instructed): typical ${product.priceTypicalIls} ILS, floor ${product.priceMinIls} ILS.`,
    `Reply length: <= ${resolveMaxReplyChars(ctx.lead.heat, ctx.runtimeConfig.ai.maxReplyChars)} characters (calibrated to lead heat=${ctx.lead.heat}). WhatsApp style: short paragraphs, no markdown headings.`,
    `Allowed lead_status transitions for this turn: ${playbook.allowedNextStatuses.join(', ')}; otherwise leave leadStatusUpdate null.`,
    `Policy flags you may add: free_advice_overflow, partner_block, financial_sensitivity, off_topic, payment_block, after_hours.`,
    `Always return valid JSON. ${RESPONSE_SCHEMA_HINT}`,
  );
  return lines.join('\n');
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

  if (ctx.intentContext) {
    lines.push(
      `Inbound intent (heuristic): ${ctx.intentContext.intent} | sentiment: ${ctx.intentContext.sentiment} | confidence: ${ctx.intentContext.confidence}`,
    );
  }

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

  const topicsSummary = summariseTopicsForPrompt(
    ctx.lead.topicsTouched as TopicEntry[] | undefined,
    ctx.timeContext?.currentTimeIso,
  );
  if (topicsSummary) {
    lines.push(
      `Topics already covered with this lead (do not repeat unless they ask): ${topicsSummary}`,
    );
  }

  lines.push(`Decide the next CRM action and the next WhatsApp reply. Return JSON only.`);
  return lines.join('\n');
}

function formatTriBool(v: boolean | null): string {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return 'unknown';
}
