// Node-side mirror of supabase/functions/_shared/member-concierge.ts
// (pure decision logic only — the Deno file adds the IO wrapper).
// Keep in sync.
//
// Deterministic concierge for program members ("הדרך לדירה"): members
// never reach the LLM. First message of a service episode gets the
// John-referral welcome; the word "מומחה" (or an explicit human
// request) hands off to a human with a 24h SLA; continued chatter gets
// one reminder per episode, then silence — the conversation waits in
// the rep's inbox.

export type ConciergeAction = 'expert' | 'greet' | 'reprompt' | 'silent';

// Exact-token matches (single words) — matched against Hebrew-letter
// tokens so 'נציג' doesn't fire inside a longer word.
const EXPERT_WORDS = new Set(['מומחה', 'נציג', 'בנאדם', 'אנושי']);

// Substring matches (phrases).
const EXPERT_PHRASES = ['בן אדם', 'אדם אמיתי', 'לדבר עם מישהו', 'שירות לקוחות', 'רוצה לדבר עם'];

export function detectExpertRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text.trim();
  if (!normalized) return false;
  const tokens = normalized.split(/[^֐-׿]+/).filter(Boolean);
  if (tokens.some((t) => EXPERT_WORDS.has(t))) return true;
  return EXPERT_PHRASES.some((p) => normalized.includes(p));
}

export interface ConciergeDecisionInput {
  text: string | null;
  /** lead.last_inbound_at as read BEFORE the current message was inserted — i.e. the previous inbound. */
  prevInboundAt: string | null;
  lastGreetedAt: string | null;
  lastRepromptedAt: string | null;
  episodeGapHours: number;
  now: Date;
}

export function decideConciergeAction(input: ConciergeDecisionInput): ConciergeAction {
  if (detectExpertRequest(input.text)) return 'expert';

  const gapMs = Math.max(1, input.episodeGapHours) * 3600 * 1000;
  const nowMs = input.now.getTime();
  const prevMs = input.prevInboundAt ? Date.parse(input.prevInboundAt) : NaN;
  const greetedMs = input.lastGreetedAt ? Date.parse(input.lastGreetedAt) : NaN;
  const repromptedMs = input.lastRepromptedAt ? Date.parse(input.lastRepromptedAt) : NaN;

  // New episode: first-ever message, or silence longer than the gap.
  const isNewEpisode = !Number.isFinite(prevMs) || nowMs - prevMs > gapMs;
  if (isNewEpisode) return 'greet';

  // Continuing episode that somehow never got a greeting (e.g. member
  // marked mid-conversation, or greeting is older than the gap).
  if (!Number.isFinite(greetedMs) || nowMs - greetedMs > gapMs) return 'greet';

  // One reminder per episode: reprompt only if we haven't since the greet.
  if (!Number.isFinite(repromptedMs) || repromptedMs < greetedMs) return 'reprompt';

  return 'silent';
}

// Fallback texts when the message_templates rows are missing — the
// concierge must never go silent because a template was deleted.
export const CONCIERGE_FALLBACK_TEXTS: Record<'member_welcome_v1' | 'member_reprompt_v1' | 'member_expert_ack_v1', string> = {
  member_welcome_v1:
    'היי {{first_name}}, כאן צוות קרנף נדל"ן 🦏\nלשאלות ידע ותוכן מהתוכנית — דברו עם ג\'ון, הסוכן הדיגיטלי החכם שלנו, בוואטסאפ {{john_phone}} (לחברי התוכנית בלבד!).\nאם ג\'ון לא סיפק מענה או שיש שאלה נוספת — כתבו כאן "מומחה" ונחזור אליכם תוך 24 שעות לכל היותר.',
  member_reprompt_v1:
    'רק מזכירים 🙂 לשאלות תוכן — ג\'ון בוואטסאפ {{john_phone}}. לכל דבר אחר כתבו "מומחה" ומומחה אנושי יחזור אליכם תוך 24 שעות.',
  member_expert_ack_v1: 'קיבלנו! מומחה מהצוות יחזור אליכם תוך 24 שעות לכל היותר 🙏',
};

export function renderConciergeText(
  body: string,
  vars: { firstName?: string | null; johnPhone?: string | null },
): string {
  return body
    .replaceAll('{{first_name}}', (vars.firstName ?? '').trim() || 'חבר/ת התוכנית')
    .replaceAll('{{john_phone}}', vars.johnPhone ?? '');
}
