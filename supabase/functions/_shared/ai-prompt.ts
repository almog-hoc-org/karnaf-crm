import type { AiDecisionContext } from './ai-contract.ts';
import type { Playbook } from './playbooks.ts';
import type { PromptOverrides } from './prompt-variant.ts';
import { formatTimeContextForPrompt } from './time-context.ts';
import { resolveMaxReplyChars } from './reply-length.ts';
import { summariseTopicsForPrompt, type TopicEntry } from './topics.ts';
import { formatClaimsForPrompt } from './claim-service.ts';
import { resolveTrackContext } from './track-context.ts';
import { linksForTrack } from './links.ts';

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
  "policyFlags": string[],
  "extractedName": string|null,
  "estimatedEquity": string|null,
  "interestSummary": string|null
}`;

export function buildAiSystemPrompt(
  playbook: Playbook,
  ctx: AiDecisionContext,
  overrides: PromptOverrides = {},
): string {
  const product = ctx.runtimeConfig.product;
  const track = resolveTrackContext(ctx.lead.primaryTrack, ctx.lead.productInterest);
  const objective =
    typeof overrides.objective === 'string' && overrides.objective.length > 0
      ? overrides.objective
      : playbook.objective;
  const guidance =
    Array.isArray(overrides.guidance) && overrides.guidance.length > 0
      ? overrides.guidance
      : playbook.guidance;
  const personaGuidance = ctx.personaContext?.guidance ?? [];
  const lines: string[] = [
    `You are the AI operator for Karnaf — a Hebrew-speaking real-estate education & investment company. Karnaf runs several distinct tracks: the digital program "${product.displayName}", presale projects, and premium 1:1 investor mentorship.`,
    `THIS lead's relevant track is: ${track.displayName}. ${track.blurb}`,
    `Your objective for this track: ${track.objective}`,
    `Do NOT assume the lead came for the flagship program. Engage on THEIR track (above) and on what they ACTUALLY said (see productInterest / classificationSummary / the conversation below) — not a generic script.`,
    `Channel is ${ctx.lead.channel === 'instagram' ? 'Instagram DM' : 'WhatsApp'}. Tone: personal, professional, courteous, never aggressive, no flattery, max one emoji when natural.`,
    `Active playbook: ${playbook.name}. Objective: ${objective}`,
    `Guidance:`,
    ...guidance.map((g) => ` - ${g}`),
    `Critical conduct rules (these override the playbook when they conflict, except safety/forbidden rules):`,
    ` - Grounding: only reference facts and events that appear in the lead profile or the conversation below. NEVER claim the lead registered for, joined, or attended a webinar/event/program unless it explicitly appears above. When unsure, do not assert it.`,
    ` - No repeated greeting: greet by name ("היי {name}") only when there is NO prior conversation history. If messages already exist, continue naturally — do not re-introduce yourself or re-greet each turn.`,
    ` - Mirror the need: explicitly acknowledge the lead's stated topic in their own words before steering anywhere. If they named a specific subject (e.g. קרקעות, מילואים, השקעה ספציפית), name it back to them.`,
    ` - Stay on the lead's track and qualify: converse about the track above, mirror what the lead said, and ask one relevant qualifying question at a time. Do NOT redirect a presale/investor/land lead back to the flagship program.`,
    ` - Hand off for specifics you don't have: for hard specifics on this track (exact prices, availability, dates, legal/contract terms, project details not in your authorised claims), do NOT invent them. Say a Karnaf specialist will follow up with the details, and hand off: escalateToMia=true, createQueueType="human_handoff", sendMode="freeform", one short bridging message. Collect the lead's preference (e.g. apartment type / budget / goal) first so the specialist has context.`,
    ` - Never drop a relevant lead: if the lead wants something outside ALL of Karnaf's tracks/services, acknowledge honestly and hand off to a human — never dismiss them or end with "maybe in the future". Losing a lead who wants a real service is a failure.`,
    ` - No near-duplicate messages: if your previous message already made a point or asked a question, advance the conversation — never resend the same content reworded.`,
    ` - Lead capture is a core goal. Early in the chat get the lead's NAME and a one-line description of what they want. Ask for estimated equity (הון עצמי) only LATER and in context — after their interest is clear, framed as matching them to the right option/track. NEVER ask for equity in the first message. When you learn the name / estimated equity / interest from the conversation, return them in extractedName / estimatedEquity / interestSummary (else null).`,
    ` - Be sharp and concise: 2–4 short sentences per reply. Your job is to capture the lead, collect basic info, answer basic questions or present the relevant service, and hand to a human — not to write essays. Keep the good, accurate explanations but trim everything else.`,
    ` - No filler or repetition: do not pad replies with openers like "אני מבין ש…" or restate the lead's message every turn; vary phrasing; never repeat an offer, push, or question you already made.`,
  ];
  if (personaGuidance.length) {
    lines.push(`Persona (${ctx.personaContext?.persona ?? 'unknown'}) guidance:`);
    for (const p of personaGuidance) lines.push(` - ${p}`);
  }
  const claimLines = formatClaimsForPrompt(ctx.authorisedClaims ?? []);
  if (claimLines.length) {
    lines.push(
      `Authorised product claims (these are the ONLY product specifics you may reference; do not invent new features, prices, or commitments):`,
    );
    for (const c of claimLines) lines.push(c);
  }
  const links = linksForTrack(track.code);
  if (links.length) {
    lines.push(
      `Authorised links — share ONLY these exact URLs, and only when the lead asks for a link or it clearly helps. NEVER invent or guess a URL:`,
    );
    for (const l of links) lines.push(` - ${l.label}: ${l.url}`);
    lines.push(
      ` - NEVER send a payment/checkout link yourself. If the lead wants to pay or get a checkout link, tell them a Karnaf specialist will send it and hand off.`,
    );
  }
  const lastSender = ctx.recentMessages.slice(-1)[0]?.senderType ?? null;
  const ownership = ctx.lead.ownershipMode;
  if (ownership === 'ai_active' && lastSender === 'lead') {
    lines.push(
      `Ownership=ai_active and the latest message is from the lead. You ARE the active responder. You MUST produce a meaningful Hebrew replyText addressing the lead's latest message (sendMode=freeform). Do not output replyText=null; do not assume a human is handling this turn. Prior messages may include human-agent replies — that handoff has been released and control is back with you.`,
    );
  } else if (ownership !== 'ai_active') {
    lines.push(
      `Ownership=${ownership}. A human handles this lead; you may set replyText=null (sendMode=no_send) and only update metadata (status/heat/score) when clearly warranted.`,
    );
  }

  lines.push(
    `Forbidden phrases (never produce, paraphrase, or imply): ${[...playbook.forbidden, ...ctx.runtimeConfig.forbiddenClaims].join('; ')}`,
    track.statesPricing
      ? `Pricing context (do not promise discounts unless instructed): typical ${product.priceTypicalIls} ILS, floor ${product.priceMinIls} ILS.`
      : `Pricing: do NOT state prices, payment terms, availability or dates for this track yourself — a Karnaf specialist provides those. Collect interest and hand off for specifics.`,
    `Reply length: <= ${resolveMaxReplyChars(ctx.lead.heat, ctx.runtimeConfig.ai.maxReplyChars)} characters (calibrated to lead heat=${ctx.lead.heat}). WhatsApp style: short paragraphs, no markdown headings.`,
    `Allowed lead_status transitions for this turn: ${playbook.allowedNextStatuses.join(', ')}; otherwise leave leadStatusUpdate null.`,
    `Policy flags you may add: free_advice_overflow, partner_block, financial_sensitivity, off_topic, payment_block, after_hours.`,
    `Always return valid JSON. ${RESPONSE_SCHEMA_HINT}`,
  );
  return lines.join('\n');
}

export function buildAiUserPrompt(ctx: AiDecisionContext): string {
  const latestLeadMessage = ctx.recentMessages.filter((m) => m.senderType === 'lead').slice(-1)[0]?.contentText ?? null;
  const recent = ctx.recentMessages
    .slice()
    .map((m) => `${m.senderType}: ${m.contentText ?? ''}`)
    .join('\n');

  const lines: string[] = [
    `Lead profile:`,
    `  id: ${ctx.lead.id}`,
    `  name: ${ctx.lead.fullName ?? 'unknown'}`,
    `  source: ${ctx.lead.source}`,
    `  sourceDetail: ${ctx.lead.sourceDetail ?? 'none'}`,
    `  sourceCampaign: ${ctx.lead.sourceCampaign ?? 'none'}`,
    `  primaryTrack: ${ctx.lead.primaryTrack ?? 'unknown'}`,
    `  inquiryType: ${ctx.lead.inquiryType ?? 'unknown'}`,
    `  productInterest: ${ctx.lead.productInterest ?? 'unknown'}`,
    `  intakeSegment: ${ctx.lead.intakeSegment ?? 'unknown'}`,
    `  classificationConfidence: ${ctx.lead.classificationConfidence ?? 'unknown'}`,
    `  classificationSummary: ${ctx.lead.classificationSummary ?? '(none)'}`,
    `  suggestedNextAction: ${ctx.lead.suggestedNextAction ?? '(none)'}`,
    `  handoffReason: ${ctx.lead.handoffReason ?? '(none)'}`,
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
    `Latest lead message that MUST be answered directly:`,
    `  ${latestLeadMessage ?? '(none)'}`,
    `Recent messages (oldest -> newest):`,
    recent || '(none)',
  ];

  if (ctx.intentContext) {
    lines.push(
      `Inbound intent (heuristic): ${ctx.intentContext.intent} | sentiment: ${ctx.intentContext.sentiment} | confidence: ${ctx.intentContext.confidence}`,
    );
  }

  lines.push(
    `Operational routing rules:`,
    `  - First answer the latest lead message directly in context. Do not send a generic intro if the conversation already has history.`,
    `  - Use details from the recent conversation and summary; avoid repeating questions or claims already covered.`,
    `  - If the latest lead message is short (e.g. "שלום", "היי"), acknowledge naturally and continue from the known context instead of restarting the funnel.`,
    `  - If intakeSegment=needs_human, do not keep selling in chat; acknowledge briefly and create/keep human handoff.`,
    `  - If intakeSegment=support_or_existing, avoid sales copy; route to Mia/support with a concise note.`,
    `  - If intakeSegment=hot_sales, answer the last blocker and move toward payment or phone sales; do not over-educate.`,
    `  - If intakeSegment=needs_nurture/info_seeker, ask only one diagnostic question after a short useful answer.`,
  );

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
    lines.push(
      `Recent AI questions already asked (do not re-ask these unless the lead explicitly invites re-asking):`,
    );
    for (const q of ctx.recentAiQuestions) lines.push(`  - ${q}`);
  }

  const topicsSummary = summariseTopicsForPrompt(
    ctx.lead.topicsTouched as TopicEntry[] | undefined,
    ctx.timeContext?.currentTimeIso,
  );
  if (topicsSummary) {
    lines.push(`Topics already covered with this lead (do not repeat unless they ask): ${topicsSummary}`);
  }

  lines.push(
    `Decide the next CRM action and the next WhatsApp reply. The replyText must be specific to the latest lead message and the conversation history. Return JSON only.`,
  );
  return lines.join('\n');
}

function formatTriBool(v: boolean | null): string {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return 'unknown';
}
