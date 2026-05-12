// Mirrored from lib/runtime/persona-inference.ts. Keep in sync.

export type LeadPersona = 'analyst' | 'impulsive' | 'skeptical' | 'delegator' | 'unknown';

export interface PersonaInput {
  leadMessages: string[];
  source: string | null;
}

export interface PersonaSignals {
  message_count: number;
  avg_message_length: number;
  short_count: number;
  verbose_count: number;
  question_count: number;
  skeptic_hits: number;
  hesitation_hits: number;
  delegator_hits: number;
}

export interface PersonaResult {
  persona: LeadPersona;
  signals: PersonaSignals;
  guidance: string[];
}

const SKEPTIC_HINTS = ['אבל', 'באמת?', 'בטוח?', 'איך אני יודע', 'איך אדע', 'נסיון רע', 'לא בטוח', 'מאמין', 'בעבר ניסיתי'];
const HESITATION_HINTS = ['אולי', 'צריך לחשוב', 'לבדוק', 'לא בטוח', 'נראה', 'אחזור אליך'];
const DELEGATOR_HINTS = [
  'בן זוג', 'בן הזוג', 'בת זוג', 'בת הזוג', 'בעל', 'אישה', 'אבדוק עם', 'אדבר עם', 'לבדוק עם', 'משפחה', 'בעלי', 'אשתי',
];
const SOURCE_ANALYST = new Set(['webinar', 'webinar_signup', 'blog', 'youtube_long', 'newsletter']);
const SOURCE_IMPULSIVE = new Set(['instagram_dm', 'tiktok', 'facebook_ad', 'whatsapp_ad', 'sms']);

const SHORT_THRESHOLD = 35;
const VERBOSE_THRESHOLD = 120;
const MIN_MSGS_FOR_CONFIDENT_PERSONA = 2;

const QUESTION_LEAD_WORDS = ['האם', 'כמה', 'מתי', 'איפה', 'למה', 'מה', 'איך', 'מי', 'איזה'];

export function inferPersona(input: PersonaInput): PersonaResult {
  const messages = (input.leadMessages ?? []).map((m) => m.trim()).filter(Boolean);
  const source = (input.source ?? '').toLowerCase();
  const signals: PersonaSignals = {
    message_count: messages.length,
    avg_message_length: 0,
    short_count: 0,
    verbose_count: 0,
    question_count: 0,
    skeptic_hits: 0,
    hesitation_hits: 0,
    delegator_hits: 0,
  };

  if (!messages.length) {
    return {
      persona: prepersonaFromSource(source) ?? 'unknown',
      signals,
      guidance: guidanceFor('unknown'),
    };
  }

  let totalLen = 0;
  for (const m of messages) {
    totalLen += m.length;
    if (m.length < SHORT_THRESHOLD) signals.short_count += 1;
    if (m.length > VERBOSE_THRESHOLD) signals.verbose_count += 1;
    if (countQuestions(m) > 0) signals.question_count += 1;
    if (matchesAny(m, SKEPTIC_HINTS)) signals.skeptic_hits += 1;
    if (matchesAny(m, HESITATION_HINTS)) signals.hesitation_hits += 1;
    if (matchesAny(m, DELEGATOR_HINTS)) signals.delegator_hits += 1;
  }
  signals.avg_message_length = Math.round(totalLen / messages.length);

  const persona = pickPersona(signals, source, messages.length);
  return { persona, signals, guidance: guidanceFor(persona) };
}

function pickPersona(
  signals: PersonaSignals,
  source: string,
  msgCount: number,
): LeadPersona {
  if (signals.delegator_hits >= 1) return 'delegator';
  if (signals.skeptic_hits >= 1) return 'skeptical';
  if (msgCount >= MIN_MSGS_FOR_CONFIDENT_PERSONA) {
    if (signals.verbose_count >= 1 && signals.question_count >= 1) return 'analyst';
    if (signals.short_count / msgCount >= 0.6) return 'impulsive';
  }
  const sourcePersona = prepersonaFromSource(source);
  if (sourcePersona) return sourcePersona;
  return 'unknown';
}

function prepersonaFromSource(source: string): LeadPersona | null {
  if (!source) return null;
  if (SOURCE_ANALYST.has(source)) return 'analyst';
  if (SOURCE_IMPULSIVE.has(source)) return 'impulsive';
  return null;
}

function countQuestions(text: string): number {
  let count = 0;
  if (text.includes('?')) count += 1;
  const firstToken = text.trim().split(/\s+/u)[0]?.toLowerCase();
  if (firstToken && QUESTION_LEAD_WORDS.includes(firstToken)) count += 1;
  return count;
}

function matchesAny(text: string, needles: string[]): boolean {
  const lower = text.toLowerCase();
  for (const n of needles) {
    if (lower.includes(n.toLowerCase())) return true;
  }
  return false;
}

export function guidanceFor(persona: LeadPersona): string[] {
  switch (persona) {
    case 'analyst':
      return [
        'הליד אנליטי: הצג הוכחות, מבנה, ROI, מספרים, שלבים מסודרים.',
        'אפשר ארוך יותר ומסודר בנקודות. הימנע מהבטחות שיווקיות חלולות.',
      ];
    case 'impulsive':
      return [
        'הליד אימפולסיבי: תשובה קצרה ומיידית, קריאה לפעולה ברורה.',
        'הצע צעד מעשי אחד מיידי. אל תפריש לרשימות ארוכות.',
      ];
    case 'skeptical':
      return [
        'הליד ספקני: התייחס לחששות במפורש לפני שאתה ממליץ.',
        'בסס את הטענות בעדויות/מנגנון. הימנע מ"אני מבטיח". הצע התחייבות הדדית קטנה.',
      ];
    case 'delegator':
      return [
        'הליד מצריך שותף החלטה (בן/בת זוג / משפחה): שלב גם אותם.',
        'הצע קישור או חומר שאפשר להעביר הלאה, ופגישת המשך לשלושה.',
      ];
    default:
      return [
        'פרסונה לא ידועה: שמור על טון נייטרלי, שאל שאלה מפתח אחת בלבד.',
      ];
  }
}
