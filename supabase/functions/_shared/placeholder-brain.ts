export interface PlaceholderDecisionInput {
  inboundText: string;
  fullName: string | null;
  source: string;
  currentStatus: string;
  currentHeat: string;
}

export interface PlaceholderDecision {
  replyText: string | null;
  leadStatusUpdate: string | null;
  leadHeatUpdate: string | null;
  scoreDelta: number;
  escalateToMia: boolean;
  escalateToPhoneSales: boolean;
  createQueueType: string | null;
  notesForMia: string | null;
}

export function decidePlaceholderReply(input: PlaceholderDecisionInput): PlaceholderDecision {
  const text = input.inboundText.trim();
  const lower = text.toLowerCase();
  const prefix = input.fullName ? `${input.fullName}, ` : '';

  if (!text) {
    return {
      replyText: 'היי, קיבלתי את ההודעה שלך. אעבור איתך מסודר כדי להבין איך הכי נכון לעזור.',
      leadStatusUpdate: input.currentStatus === 'new' ? 'first_contact_sent' : null,
      leadHeatUpdate: null,
      scoreDelta: 2,
      escalateToMia: false,
      escalateToPhoneSales: false,
      createQueueType: null,
      notesForMia: null,
    };
  }

  if (lower.includes('לא מעוניין') || lower.includes('תסיר') || lower.includes('להסיר')) {
    return {
      replyText: `${prefix}הבנתי, עוצר כאן ולא אמשיך לפנות.`,
      leadStatusUpdate: 'do_not_contact',
      leadHeatUpdate: 'cold',
      scoreDelta: -20,
      escalateToMia: false,
      escalateToPhoneSales: false,
      createQueueType: null,
      notesForMia: null,
    };
  }

  if (lower.includes('נציג') || lower.includes('מישהו') || lower.includes('לדבר')) {
    return {
      replyText: `${prefix}בשמחה. אני מסדר שמיה תראה את זה ותמשיך איתך בצורה מסודרת.`,
      leadStatusUpdate: 'human_handoff',
      leadHeatUpdate: 'warm',
      scoreDelta: 8,
      escalateToMia: true,
      escalateToPhoneSales: false,
      createQueueType: 'human_handoff',
      notesForMia: 'Lead explicitly requested a human or direct conversation.',
    };
  }

  if (lower.includes('מחיר') || lower.includes('כמה עולה')) {
    return {
      replyText: `${prefix}בשמחה. לפני שאני זורק תשובת מחיר יבשה, חשוב לי להבין אם הכיוון שלך הוא דירה ראשונה או השקעה ראשונה, כדי לכוון נכון.`,
      leadStatusUpdate: input.currentStatus === 'new' ? 'first_contact_sent' : 'responded',
      leadHeatUpdate: 'warm',
      scoreDelta: 6,
      escalateToMia: false,
      escalateToPhoneSales: false,
      createQueueType: null,
      notesForMia: null,
    };
  }

  if (lower.includes('התקשר') || lower.includes('שיחה')) {
    return {
      replyText: `${prefix}ברור. אני מסמן את זה כדי לבדוק אם שיחה קצרה היא הצעד הנכון עבורך.`,
      leadStatusUpdate: 'human_handoff',
      leadHeatUpdate: 'hot',
      scoreDelta: 10,
      escalateToMia: true,
      escalateToPhoneSales: true,
      createQueueType: 'phone_escalation',
      notesForMia: 'Lead asked for a call or hinted that a call may help.',
    };
  }

  return {
    replyText: `${prefix}מעולה, קיבלתי. כדי לכוון אותך נכון, מה בעיקר מעניין אותך עכשיו סביב רכישת הדירה?`,
    leadStatusUpdate: input.currentStatus === 'new' ? 'first_contact_sent' : 'responded',
    leadHeatUpdate: input.currentHeat === 'cold' ? 'cool' : null,
    scoreDelta: 4,
    escalateToMia: false,
    escalateToPhoneSales: false,
    createQueueType: null,
    notesForMia: null,
  };
}
