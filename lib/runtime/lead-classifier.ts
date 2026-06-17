// Deterministic lead-intake classifier. This is intentionally cheap and
// explainable so operators and tests can see why a lead was tagged before
// any LLM decision runs.
//
// Mirrored by supabase/functions/_shared/lead-classifier.ts.

export type InquiryType =
  | 'program_details'
  | 'pricing'
  | 'financing'
  | 'eligibility'
  | 'property_search'
  | 'mentorship'
  | 'purchase_ready'
  | 'support'
  | 'unknown';

export type ProductInterest =
  | 'digital_program'
  | 'investor_mentorship'
  | 'contractor_group_purchase'
  | 'personal_consultation'
  // Legacy values kept so older rows still render/round-trip safely.
  | 'mentorship'
  | 'student_tools'
  | 'financing_guidance'
  | 'unknown';

export type IntakeSegment =
  | 'hot_sales'
  | 'needs_human'
  | 'needs_nurture'
  | 'info_seeker'
  | 'support_or_existing'
  | 'unknown';

export interface LeadClassificationInput {
  source?: string | null;
  sourceDetail?: string | null;
  sourceCampaign?: string | null;
  firstMessage?: string | null;
  latestMessage?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface LeadClassificationSignal {
  inquiryType: InquiryType;
  productInterest: ProductInterest;
  intakeSegment: IntakeSegment;
  confidence: 'high' | 'medium' | 'low';
  matchedKeywords: string[];
  operatorSummary: string;
  suggestedNextAction: string;
  handoffReason: string | null;
}

const PROGRAM_HINTS = ['דרך לדירה', 'הדרך לדירה', 'תוכנית', 'תכנית', 'קורס', 'לימודים', 'הכשרה', 'מסלול', 'נדלן', 'נדל״ן', 'נדל"ן'];
const PRICE_HINTS = ['מחיר', 'עלות', 'כמה עולה', 'כמה זה עולה', 'תשלום', 'משלמים', 'יקר'];
const FINANCING_HINTS = ['משכנתא', 'מימון', 'הון עצמי', 'הלוואה', 'בנק', 'תקציב'];
const ELIGIBILITY_HINTS = ['מתאים לי', 'מתאים עבורי', 'בלי ניסיון', 'מתחיל', 'מתחילה', 'גיל', 'זכאות'];
const PROPERTY_HINTS = ['דירה', 'נכס', 'עסקה', 'השקעה', 'אזור', 'תשואה', 'חיפה', 'באר שבע'];
const INVESTOR_MENTORSHIP_HINTS = ['ליווי משקיעים', 'ליווי למשקיעים', 'ליווי השקעות', 'מנטור', 'מנטורינג', 'ליווי'];
const CONTRACTOR_GROUP_HINTS = ['קבוצת רכישה', 'קבוצה מקבלן', 'מקבלן', 'קבלן', 'יזם', 'פרויקט חדש', 'דירה מקבלן'];
const CONSULTATION_HINTS = ['שיחת ייעוץ', 'ייעוץ אישי', 'שיחה אישית', 'שיחה עם יועץ', 'פגישת ייעוץ', 'פגישה אישית'];
// Topics the flagship digital program does NOT cover — must go to a human, never into the program funnel.
const LAND_HINTS = ['קרקעות', 'קרקע', 'מילואים', 'משתכן', 'הפשרת קרקע', 'קרקע חקלאית', 'מגרש'];
const BUY_HINTS = ['רוצה להירשם', 'רוצה להתחיל', 'איך נרשמים', 'איך משלמים', 'לסגור', 'לרכוש'];
const HUMAN_HINTS = ['נציג', 'בן אדם', 'בנאדם', 'שיחה', 'תתקשרו', 'טלפון', 'מיה'];
const SUPPORT_HINTS = ['כבר נרשמתי', 'אני תלמיד', 'גישה', 'התחברות', 'חשבונית', 'תמיכה'];

export function classifyLeadIntake(input: LeadClassificationInput): LeadClassificationSignal {
  const haystack = [
    input.source,
    input.sourceDetail,
    input.sourceCampaign,
    input.firstMessage,
    input.latestMessage,
    metadataText(input.metadata),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!haystack.trim()) {
    return buildSignal('unknown', 'unknown', 'unknown', [], 'low');
  }

  const matched: string[] = [];
  const hit = (label: string, words: string[]) => {
    const found = firstMatch(haystack, words);
    if (found) matched.push(`${label}:${found}`);
    return found;
  };

  const support = hit('support', SUPPORT_HINTS);
  const buy = hit('buy', BUY_HINTS);
  const human = hit('human', HUMAN_HINTS);
  const price = hit('pricing', PRICE_HINTS);
  const financing = hit('financing', FINANCING_HINTS);
  const eligibility = hit('eligibility', ELIGIBILITY_HINTS);
  const property = hit('property', PROPERTY_HINTS);
  const investorMentorship = hit('investor_mentorship', INVESTOR_MENTORSHIP_HINTS);
  const contractorGroup = hit('contractor_group_purchase', CONTRACTOR_GROUP_HINTS);
  const consultation = hit('personal_consultation', CONSULTATION_HINTS);
  const land = hit('land', LAND_HINTS);
  const program = hit('program', PROGRAM_HINTS);

  let inquiryType: InquiryType = 'unknown';
  if (support) inquiryType = 'support';
  else if (buy) inquiryType = 'purchase_ready';
  else if (land) inquiryType = 'property_search';
  else if (price) inquiryType = 'pricing';
  else if (financing) inquiryType = 'financing';
  else if (eligibility) inquiryType = 'eligibility';
  else if (contractorGroup || property) inquiryType = 'property_search';
  else if (investorMentorship || consultation) inquiryType = 'mentorship';
  else if (program) inquiryType = 'program_details';

  let productInterest: ProductInterest = 'unknown';
  if (contractorGroup) productInterest = 'contractor_group_purchase';
  else if (consultation || human) productInterest = 'personal_consultation';
  else if (investorMentorship) productInterest = 'investor_mentorship';
  else if (program || price || buy || eligibility || property || financing) productInterest = 'digital_program';

  let intakeSegment: IntakeSegment = 'unknown';
  if (support) intakeSegment = 'support_or_existing';
  else if (buy) intakeSegment = 'hot_sales';
  else if (land) intakeSegment = 'needs_human';
  else if (human) intakeSegment = 'needs_human';
  else if (price || financing || eligibility) intakeSegment = 'needs_nurture';
  else if (program || property || investorMentorship || contractorGroup || consultation) intakeSegment = 'info_seeker';

  const confidence = matched.length >= 3 ? 'high' : matched.length >= 1 ? 'medium' : 'low';
  // Land/reservist interest is outside the digital program — hand to a human with a specific reason.
  const handoffReasonOverride = land && !support && !buy
    ? 'עניין בקרקעות/מילואים — מחוץ לתוכנית הדיגיטלית, דורש בדיקת נציג אנושי'
    : null;
  return buildSignal(inquiryType, productInterest, intakeSegment, matched, confidence, handoffReasonOverride);
}

function buildSignal(
  inquiryType: InquiryType,
  productInterest: ProductInterest,
  intakeSegment: IntakeSegment,
  matchedKeywords: string[],
  confidence: LeadClassificationSignal['confidence'],
  handoffReasonOverride: string | null = null,
): LeadClassificationSignal {
  const handoffReason =
    handoffReasonOverride ??
    (intakeSegment === 'needs_human'
      ? 'הליד ביקש שיחה/נציג אנושי'
      : intakeSegment === 'hot_sales'
        ? 'כוונת רכישה גבוהה — מומלץ נציג מכירות אם יש חסם או שאלת תשלום'
        : intakeSegment === 'support_or_existing'
          ? 'נראה כמו תלמיד/לקוח קיים — טיפול תמיכה אנושי'
          : null);

  return {
    inquiryType,
    productInterest,
    intakeSegment,
    confidence,
    matchedKeywords,
    operatorSummary: operatorSummary(inquiryType, productInterest, intakeSegment),
    suggestedNextAction: suggestedNextAction(intakeSegment, inquiryType),
    handoffReason,
  };
}

function operatorSummary(inquiry: InquiryType, product: ProductInterest, segment: IntakeSegment): string {
  return `סיווג: ${label(inquiry)} · מוצר: ${label(product)} · מסלול טיפול: ${label(segment)}`;
}

function suggestedNextAction(segment: IntakeSegment, inquiry: InquiryType): string {
  if (segment === 'hot_sales') return 'לאמת התאמה קצרה, לענות על חסם אחרון ולהציע הרשמה/שיחה.';
  if (segment === 'needs_human') return 'להעביר לנציג עם סיכום קצר וסיבת הפנייה.';
  if (segment === 'support_or_existing') return 'לעצור מכירה אוטומטית ולבדוק אם זה לקוח/תלמיד קיים.';
  if (inquiry === 'pricing' || inquiry === 'financing')
    return 'לתת מסגרת ערך לפני מחיר, לזהות תקציב וחסם החלטה.';
  if (segment === 'info_seeker') return 'לתת תשובה קצרה ולשאול שאלת אבחון אחת.';
  return 'לשאול שאלת אבחון אחת כדי להבין צורך, מוצר ורמת בשלות.';
}

function label(value: string): string {
  const labels: Record<string, string> = {
    program_details: 'פרטי תוכנית',
    pricing: 'מחיר',
    financing: 'מימון/משכנתא',
    eligibility: 'התאמה',
    property_search: 'איתור עסקה/נכס',
    mentorship: 'ליווי',
    purchase_ready: 'רכישה עכשיו',
    support: 'תמיכה/לקוח קיים',
    digital_program: 'תוכנית הדרך לדירה',
    investor_mentorship: 'ליווי משקיעים',
    contractor_group_purchase: 'קבוצת רכישה מקבלן',
    personal_consultation: 'שיחת ייעוץ אישית',
    student_tools: 'כלי תלמידים',
    financing_guidance: 'הכוונת מימון',
    hot_sales: 'מכירה חמה',
    needs_human: 'נציג אנושי',
    needs_nurture: 'טיפוח/הבשלה',
    info_seeker: 'מחפש מידע',
    support_or_existing: 'תמיכה/קיים',
    unknown: 'לא ידוע',
  };
  return labels[value] ?? value;
}

function firstMatch(lower: string, needles: string[]): string | null {
  for (const n of needles) {
    if (lower.includes(n.toLowerCase())) return n;
  }
  return null;
}

function metadataText(metadata: Record<string, unknown> | null | undefined): string {
  if (!metadata) return '';
  return Object.entries(metadata)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .map(([k, v]) => `${k}:${String(v)}`)
    .join(' ');
}
