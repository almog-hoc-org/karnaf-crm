// Track-aware conversation context. Karnaf markets several distinct tracks;
// the bot must converse about the lead's ACTUAL track instead of always
// pitching the flagship digital program. The lead's `primary_track` is set
// deterministically at intake (intake_source_contracts); product_interest is
// a softer fallback. For any track, hard specifics (prices, availability,
// dates, legal/contract terms) are handed to a human — the bot never invents.
//
// Node-side mirror of supabase/functions/_shared/track-context.ts. Keep in sync.

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

export const TRACKS: Record<string, TrackContext> = {
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

export function resolveTrackContext(
  primaryTrack?: string | null,
  productInterest?: string | null,
): TrackContext {
  const t = (primaryTrack ?? '').trim();
  if (t && TRACKS[t]) return TRACKS[t];
  const pi = (productInterest ?? '').trim();
  if (pi === 'investor_mentorship' || pi === 'mentorship') return TRACKS.investor_mentorship;
  if (pi === 'contractor_group_purchase') return TRACKS.presale;
  return FLAGSHIP;
}
