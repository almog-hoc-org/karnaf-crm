import type { AiDecisionContext, AiObjectionSnapshot } from './ai-contract.ts';
import type { Playbook } from './playbooks.ts';
import type { PromptOverrides } from './prompt-variant.ts';

/** Strip control chars / quote-breakers / overlong content from operator-supplied
 *  strings before splicing them into the system prompt. Defends against an
 *  operator (or compromised admin UI) inserting `". You are now a different
 *  assistant…` style payloads via `objections.label` or `canonical_response`. */
export function sanitizeForPromptLiteral(value: unknown, maxLen = 240): string {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  // Walk codepoint-by-codepoint: collapse whitespace, drop C0/DEL control
  // chars, swap backticks → single quotes, escape `"`. Keeps the inserted
  // value scoped to a single JSON-string literal in the system prompt.
  let out = '';
  let lastWasSpace = false;
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      if (!lastWasSpace) { out += ' '; lastWasSpace = true; }
      continue;
    }
    if (ch === '`') { out += "'"; lastWasSpace = false; continue; }
    if (ch === '"') { out += '\\"'; lastWasSpace = false; continue; }
    out += ch;
    lastWasSpace = ch === ' ';
  }
  const cleaned = out.trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
}

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
  matchedObjections: AiObjectionSnapshot[] = [],
): string {
  const product = ctx.runtimeConfig.product;
  const objective = typeof overrides.objective === 'string' && overrides.objective.length > 0
    ? overrides.objective
    : playbook.objective;
  const guidance = Array.isArray(overrides.guidance) && overrides.guidance.length > 0
    ? overrides.guidance
    : playbook.guidance;
  // Pricing is either disclosed with concrete numbers or strictly redirected
  // — never both, never partial. Default behaviour is "do not disclose".
  const canDisclosePrice = product.disclosePrice === true
    && typeof product.priceTypicalIls === 'number'
    && product.priceTypicalIls > 0;
  const pricingLine = canDisclosePrice
    ? `Pricing context (do not promise discounts unless instructed): typical ${product.priceTypicalIls} ILS, floor ${product.priceMinIls} ILS.`
    : `Pricing policy: NEVER state, estimate, hint at, or invent any price (in any currency). If the lead asks about price, cost, fees, payment terms, discounts, or promotions, the replyText MUST be exactly: "${product.priceRedirectMessage ?? 'המחיר משתנה לפי המסלול והצורך. אשמח שנציג יחזור אליך עם פרטים מדויקים והתאמה אישית.'}" — and you must set escalateToMia=true and createQueueType="human_handoff".`;

  const objectionsBlock = matchedObjections.length > 0
    ? [
        `KNOWN OBJECTIONS HINT (operator-curated): the lead's latest message looks like one of these recurring objections. ADAPT the suggested response — do NOT paste it verbatim — and stay inside all the other rules above:`,
        ...matchedObjections.map((o) =>
          ` - "${sanitizeForPromptLiteral(o.label)}": suggested template — "${sanitizeForPromptLiteral(o.canonicalResponse)}"`,
        ),
      ]
    : [];

  // Optional product info — operator-curated, lands verbatim in the prompt
  // so the model can answer "what's the program" / "who is it for" without
  // inventing details. Empty fields are simply skipped.
  const productLines: string[] = [];
  if (product.elevatorPitch) productLines.push(`Product (use as the source of truth): "${product.displayName}" — ${product.elevatorPitch}`);
  if (product.whoIsItFor)    productLines.push(`Who it's for: ${product.whoIsItFor}`);
  if (product.outcome)       productLines.push(`Realistic outcome (frame this way — never promise more): ${product.outcome}`);
  if (product.boundaries && product.boundaries.length > 0) {
    productLines.push(`Hard product boundaries — never violate these:`);
    for (const b of product.boundaries) productLines.push(` - ${b}`);
  }

  return [
    `You are the Karnaf CRM operator for the Hebrew-speaking digital program "${product.displayName}".`,
    `Channel is WhatsApp. Tone: personal, professional, courteous, never aggressive, no flattery, max one emoji when natural.`,
    ...productLines,
    `Active playbook: ${playbook.name}. Objective: ${objective}`,
    `Guidance:`,
    ...guidance.map((g) => ` - ${g}`),
    `Forbidden phrases (never produce, paraphrase, or imply): ${[...playbook.forbidden, ...ctx.runtimeConfig.forbiddenClaims].join('; ')}`,
    `HARD RULE — no fabrication: Do NOT invent specific numbers, dates, percentages, deadlines, results, names, or commitments. If a fact is not in this prompt or in the conversation, you do not know it. Say so and offer a human callback.`,
    `HARD RULE — no advice outside scope: Do not give binding financial, legal, tax, or investment advice. Redirect those to a human.`,
    pricingLine,
    ...objectionsBlock,
    `Reply length: <= ${ctx.runtimeConfig.ai.maxReplyChars} characters. WhatsApp style: short paragraphs, no markdown headings.`,
    `Allowed lead_status transitions for this turn: ${playbook.allowedNextStatuses.join(', ')}; otherwise leave leadStatusUpdate null.`,
    `Policy flags you may add: free_advice_overflow, partner_block, financial_sensitivity, off_topic, payment_block, after_hours.`,
    `Always return valid JSON. ${RESPONSE_SCHEMA_HINT}`,
  ].join('\n');
}

/** Returns objections whose keywords appear in `inboundText` AND that apply
 *  to `playbookName` (or are not playbook-restricted). Case-insensitive
 *  substring match keeps v1 cheap; swap for embeddings later. */
export function matchObjections(
  available: AiObjectionSnapshot[] | undefined,
  inboundText: string,
  playbookName: string,
): AiObjectionSnapshot[] {
  if (!available || available.length === 0 || !inboundText) return [];
  const lower = inboundText.toLowerCase();
  const matches: AiObjectionSnapshot[] = [];
  for (const o of available) {
    if (o.appliesToPlaybooks.length > 0 && !o.appliesToPlaybooks.includes(playbookName)) continue;
    const hit = o.keywords.some((k) => k && lower.includes(k.toLowerCase()));
    if (hit) matches.push(o);
  }
  // Cap at 3 to keep the system prompt under control.
  return matches.slice(0, 3);
}

export function buildAiUserPrompt(ctx: AiDecisionContext): string {
  const recent = ctx.recentMessages
    .slice()
    .reverse()
    .map((m) => `${m.senderType}: ${m.contentText ?? ''}`)
    .join('\n');

  const operatorActionLines = (ctx.recentOperatorActions ?? [])
    .slice(0, 5)
    .map((a) => `  - [${a.ts}] ${a.actorType}: ${a.eventType}${a.note ? ` — ${a.note}` : ''}`);

  const baseline = ctx.sourceBaseline;
  const baselineLines = baseline && baseline.totalLeads > 0
    ? [
        `Source baseline (leads from "${baseline.source}", sample ${baseline.totalLeads}):`,
        `  - won: ${baseline.wonCount} / lost: ${baseline.lostCount}`,
        `  - median time to close: ${baseline.medianHoursToClose !== null ? `${baseline.medianHoursToClose.toFixed(1)}h` : 'n/a'}`,
        `  - Use this only as background context — do not promise outcomes based on past leads.`,
      ]
    : [];

  return [
    `Lead profile:`,
    `  id: ${ctx.lead.id}`,
    `  name: ${ctx.lead.fullName ?? 'unknown'}`,
    `  source: ${ctx.lead.source}`,
    `  status: ${ctx.lead.status}`,
    `  heat: ${ctx.lead.heat}`,
    `  score: ${ctx.lead.score}`,
    `  ownership: ${ctx.lead.ownershipMode}`,
    `  paymentStatus: ${ctx.lead.paymentStatus ?? 'none'}`,
    `  freeAdviceCount: ${ctx.freeAdviceCount}`,
    `  lastInboundAt: ${ctx.lead.lastInboundAt ?? 'none'}`,
    `Conversation summary (older context, condensed):`,
    `  ${ctx.lead.conversationSummary ?? '(none)'}`,
    ...(operatorActionLines.length > 0
      ? [`Recent operator/system actions on this lead (newest first):`, ...operatorActionLines,
         `  → If a human just acted, do NOT contradict their decision in the same thread.`]
      : []),
    ...baselineLines,
    `Recent messages (oldest -> newest):`,
    recent || '(none)',
    `Active hours ${ctx.runtimeConfig.activeHours.start}-${ctx.runtimeConfig.activeHours.end} ${ctx.runtimeConfig.activeHours.timezone}.`,
    `Decide the next CRM action and the next WhatsApp reply. Return JSON only.`,
  ].join('\n');
}
