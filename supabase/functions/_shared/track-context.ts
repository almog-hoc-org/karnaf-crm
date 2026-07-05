// Track-aware conversation context. Karnaf markets several distinct tracks;
// the bot must converse about the lead's ACTUAL track instead of always
// pitching the flagship digital program. The lead's `primary_track` is set
// deterministically at intake (intake_source_contracts); product_interest is
// a softer fallback. For any track, hard specifics (prices, availability,
// dates, legal/contract terms) are handed to a human — the bot never invents.
//
// Mirrored by lib/runtime/track-context.ts (unit-tested there).

export interface TrackContext {
  code: string;
  displayName: string;
  blurb: string;
  objective: string;
  /** Whether the bot may state pricing itself (only the flagship program). */
  statesPricing: boolean;
}

const FLAGSHIP: TrackContext = {
  code: 'program',
  displayName: 'הדרך לדירה',
  blurb:
    'תוכנית ליווי דיגיטלית של קרנף נדל״ן לרכישת דירה ראשונה — מהבנת המצב הפיננסי וההון העצמי ועד ההכנה למשכנתא, עם ליווי אישי בכל שלב.',
  objective: 'לאתר את הצורך והבשלות, לתת ערך קצר, ולקדם להרשמה או לשיחה עם נציג.',
  statesPricing: true,
};

export const TRACKS: {
  program: TrackContext;
  presale: TrackContext;
  investor_mentorship: TrackContext;
  [key: string]: TrackContext | undefined;
} = {
  program: FLAGSHIP,
  presale: {
    code: 'presale',
    displayName: 'פריסייל — פרויקט בוטיק בפתח תקווה (פרויקט סיני) של קרנף נדל״ן',
    blurb:
      'הזדמנות פריסייל בפרויקט בוטיק למגורים בפתח תקווה. הלקוח השאיר פרטים בדף הפרויקט, לרוב עם העדפה לסוג דירה מסוים.',
    objective:
      'להכיר בעניין בפרויקט הספציפי במילים של הלקוח, לאשר איזו דירה/תקציב מעניינים אותו, לבדוק רצינות וזמינות לשיחה, ולתאם המשך עם נציג קרנף. אל תנקוב במחירים/זמינות/תאריכים — אלה נמסרים על ידי נציג.',
    statesPricing: false,
  },
  investor_mentorship: {
    code: 'investor_mentorship',
    displayName: 'ליווי משקיעים פרימיום',
    blurb:
      'ליווי השקעות נדל״ן אחד-על-אחד, מקצה לקצה, עם מומחה קרנף נדל״ן — מותאם אישית למשקיע.',
    objective:
      'להבין ברמה כללית את הניסיון, ההון ויעדי ההשקעה של הלקוח, להציג את הערך של ליווי אישי צמוד, ולתאם שיחת התאמה עם מומחה. תנאים מסחריים ומספרים — דרך נציג.',
    statesPricing: false,
  },
};

// Track-neutral context for a generic consultation/agent request when no specific
// track is established — the bot understands the need and routes to a human/the
// right track, instead of defaulting to a flagship-program pitch.
const CONSULTATION: TrackContext = {
  code: 'consultation',
  displayName: 'ייעוץ והכוונה בקרנף נדל״ן',
  blurb:
    'הלקוח מבקש ייעוץ/שיחה כללית. קרנף מציעה כמה מסלולים (תוכנית דיגיטלית, פריסייל, ליווי משקיעים פרימיום) — עוד לא ברור מה הכי מתאים לו.',
  objective:
    'להבין בקצרה מה הלקוח צריך ולחבר אותו למסלול המתאים או לנציג. אל תניח שהוא רוצה את התוכנית הדיגיטלית; אל תדחוף מוצר ספציפי לפני שהבנת את הצורך.',
  statesPricing: false,
};

export function resolveTrackContext(
  primaryTrack?: string | null,
  productInterest?: string | null,
): TrackContext {
  const t = (primaryTrack ?? '').trim();
  const known = t ? TRACKS[t] : undefined;
  if (known) return known;
  const pi = (productInterest ?? '').trim();
  if (pi === 'investor_mentorship' || pi === 'mentorship') return TRACKS.investor_mentorship;
  if (pi === 'contractor_group_purchase') return TRACKS.presale;
  if (pi === 'personal_consultation') return CONSULTATION;
  return FLAGSHIP;
}
