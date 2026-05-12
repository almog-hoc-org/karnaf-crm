// Mirrored from lib/runtime/topics.ts. Keep in sync.

export type TopicKey =
  | 'price'
  | 'timeline'
  | 'format'
  | 'partner'
  | 'guarantee'
  | 'success_stories'
  | 'next_steps'
  | 'qualification';

export interface TopicEntry {
  topic: TopicKey;
  count: number;
  last_at: string;
}

const TOPIC_KEYWORDS: Record<TopicKey, string[]> = {
  price: ['מחיר', 'עלות', 'תשלום', 'תקציב', 'שקל', '₪', 'ils', 'price', 'cost'],
  timeline: ['מתי', 'תאריך', 'התחלה', 'משך', 'כמה זמן', 'שבוע', 'חודש', 'timeline', 'schedule'],
  format: ['וובינר', 'הקלטה', 'מפגש', 'אונליין', 'live', 'recordings', 'pdf', 'video', 'webinar'],
  partner: ['בן זוג', 'בת זוג', 'בעל', 'אישה', 'משפחה', 'אדבר עם', 'לבדוק עם', 'partner', 'spouse'],
  guarantee: ['החזר', 'אחריות', 'ערבות', 'guarantee', 'refund', 'money back'],
  success_stories: ['ממליצים', 'תעודות', 'בוגרים', 'סיפור הצלחה', 'testimonial', 'success'],
  next_steps: ['קישור', 'הרשמה', 'להירשם', 'תשלום מאובטח', 'חתימה', 'register', 'sign up', 'enroll'],
  qualification: ['שאלון', 'שאלות', 'איתור', 'מתאים לך', 'התאמה', 'qualification', 'fit'],
};

const MAX_TOPICS = 24;

export function extractTopicsFromText(text: string | null | undefined): TopicKey[] {
  const raw = (text ?? '').toLowerCase();
  if (!raw) return [];
  const hits: TopicKey[] = [];
  for (const [topic, words] of Object.entries(TOPIC_KEYWORDS) as [TopicKey, string[]][]) {
    if (words.some((w) => raw.includes(w.toLowerCase()))) hits.push(topic);
  }
  return hits;
}

export function mergeTopics(
  existing: TopicEntry[] | null | undefined,
  newHits: TopicKey[],
  now: Date = new Date(),
): TopicEntry[] {
  const merged: Record<TopicKey, TopicEntry> = {} as Record<TopicKey, TopicEntry>;
  for (const e of existing ?? []) {
    if (!e || typeof e !== 'object') continue;
    const t = e.topic as TopicKey;
    const c = Number(e.count);
    if (!t || !Number.isFinite(c)) continue;
    merged[t] = { topic: t, count: Math.max(0, Math.trunc(c)), last_at: String(e.last_at ?? now.toISOString()) };
  }
  const iso = now.toISOString();
  for (const t of newHits) {
    const prior = merged[t];
    merged[t] = { topic: t, count: (prior?.count ?? 0) + 1, last_at: iso };
  }
  const ordered = Object.values(merged).sort((a, b) => b.last_at.localeCompare(a.last_at));
  return ordered.slice(0, MAX_TOPICS);
}

export function summariseTopicsForPrompt(topics: TopicEntry[] | null | undefined, nowIso?: string): string {
  if (!topics || !topics.length) return '';
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  const parts = topics.map((t) => {
    const ageMin = Number.isFinite(Date.parse(t.last_at))
      ? Math.max(0, Math.floor((now - Date.parse(t.last_at)) / 60000))
      : null;
    const age = ageMin == null ? '?' : ageMin < 60 ? `${ageMin}m` : ageMin < 24 * 60 ? `${Math.floor(ageMin / 60)}h` : `${Math.floor(ageMin / (24 * 60))}d`;
    return `${t.topic}=${t.count}x(${age})`;
  });
  return parts.join(' | ');
}
