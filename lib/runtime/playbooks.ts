// Playbook selection logic. Mirrored across Node (this file) and Deno
// (supabase/functions/_shared/playbooks.ts). Keep the two in sync.
//
// Each playbook narrows the system prompt with a specific objective and
// guardrails so the model stays on rails for that conversation moment.

export interface Playbook {
  name: string;
  trigger: string;
  objective: string;
  guidance: string[];
  forbidden: string[];
  allowedNextStatuses: string[];
}

export const PLAYBOOKS: Playbook[] = [
  {
    name: 'first_contact_whatsapp_inbound',
    trigger: 'lead_status=new and source in (whatsapp,instagram_dm)',
    objective: 'לבסס קשר אנושי, לאשר רלוונטיות, ולשאול שאלת איתות אחת.',
    guidance: [
      'הצג את הכוונה לעזור בלי הבטחות.',
      'שאל שאלה פתוחה אחת בלבד שמאתרת אם מדובר בדירה ראשונה או השקעה.',
      'אל תשלח את הקישור עדיין.',
    ],
    forbidden: ['התחייבות לרווח', 'מבטיח חיסכון', 'הבטחה לרכישה'],
    allowedNextStatuses: ['first_contact_sent', 'human_handoff', 'do_not_contact', 'removed_by_request'],
  },
  {
    name: 'first_contact_form_lead',
    trigger: 'lead_status=new and source in (landing_page,webinar,responder_form,lead_magnet)',
    objective: 'לזהות את הצורך האמיתי של הליד ולהגיב אליו — לא להניח שהגיע בשביל התוכנית.',
    guidance: [
      'אזכר את מקור ההרשמה רק אם הוא ידוע בוודאות, בלי להמציא אירוע (וובינר/הרשמה) שלא קרה.',
      'שקף את מה שהליד כתב במילים שלו לפני שאתה מכוון לאנשהו.',
      'שאל שאלה אחת לאיתור הצורך — לא לדחוף את התוכנית.',
      'אם הצורך מחוץ למה שהתוכנית מכסה (למשל קרקעות/מילואים/השקעה ספציפית) — אל תנסה להחזיר לתוכנית; אשר בכנות והעבר לנציג (escalateToMia=true, createQueueType=human_handoff).',
    ],
    forbidden: ['התחייבות לתשואה', 'מובטח להצליח'],
    allowedNextStatuses: ['first_contact_sent', 'human_handoff', 'do_not_contact', 'removed_by_request'],
  },
  {
    name: 'qualification',
    trigger: 'lead_status in (first_contact_sent,responded,nurture)',
    objective: 'להעמיק הבנה של מצב הליד: יעד, מוכנות, חסם, שותף/ה.',
    guidance: [
      'שאלה אחת או שתיים לכל היותר בכל הודעה.',
      'הימנע מסקירה מלאה של התוכנית; השאר מקום לעניין.',
      'אם זוהתה מוכנות גבוהה, סמן heat=hot והעלה בציון.',
      'אם הליד מבקש נושא שהתוכנית לא עוסקת בו — אל תחזור על אותו הסבר; אשר בכנות והעבר לנציג אנושי (escalateToMia=true, createQueueType=human_handoff).',
    ],
    forbidden: ['התחייבות לתשואה', 'מבטיח להוזיל מחיר', 'הבטחה לרכישה'],
    allowedNextStatuses: ['responded', 'qualified', 'nurture', 'human_handoff', 'lost', 'do_not_contact', 'removed_by_request'],
  },
  {
    name: 'price_objection',
    trigger: 'inbound mentions price/cost',
    objective: 'לעבד את ההתנגדות בלי להוריד מחיר ובלי להתפתל.',
    guidance: [
      'אישור קצר של ההתלבטות.',
      'הסבר ערך פרקטי ב-1-2 משפטים.',
      'הזמן לצעד הבא רק לאחר שהבעת הבנה.',
    ],
    forbidden: ['הנחה אישית', 'מבצע סודי', 'מבטיח החזר השקעה'],
    allowedNextStatuses: ['responded', 'qualified', 'human_handoff', 'lost'],
  },
  {
    name: 'free_advice_boundary',
    trigger: 'lead asks repeated advisory questions without progressing',
    objective: 'לתחום בנימוס ולחבר חזרה לתוכנית.',
    guidance: [
      'תן תשובה תמציתית אחת אחרונה.',
      'הסבר שמיצוי הערך נמצא בתוך התוכנית.',
      'הצע צעד פעולה ברור: שיחה קצרה או רכישה.',
    ],
    forbidden: ['הבטחה לתשובה מלאה בחינם', 'התחייבות מקצועית מחייבת'],
    allowedNextStatuses: ['responded', 'qualified', 'nurture', 'human_handoff', 'lost'],
  },
  {
    name: 'checkout_push',
    trigger: 'lead_status in (qualified,responded) and value confirmed',
    objective: 'לדחוף לשלב הרכישה כשיש בשלות.',
    guidance: [
      'הזכר את הערך בקצרה (1 משפט).',
      'הוסף את קריאה לפעולה ברורה.',
      'אם יש חיכוך, הצע handoff למיה.',
    ],
    forbidden: ['התחייבות לרכישה', 'הבטחת תוצאה'],
    allowedNextStatuses: ['checkout_pushed', 'human_handoff'],
  },
  {
    name: 'payment_pending_rescue',
    trigger: 'lead_status=payment_pending more than X hours',
    objective: 'לסייע להשלים תשלום או להעביר למיה.',
    guidance: [
      'שאל אם יש קושי טכני או החלטתי.',
      'אם החלטתי - שלוף ל-Mia מיידית.',
    ],
    forbidden: ['לחץ אגרסיבי', 'הבטחת מבצע מיוחד'],
    allowedNextStatuses: ['won', 'human_handoff', 'lost'],
  },
  {
    name: 'phone_request',
    trigger: 'lead asks for a call or human',
    objective: 'לאסוף את הבקשה ולסמן ל-Mia + phone escalation.',
    guidance: [
      'אישור קצר של הבקשה.',
      'הבטחה למעקב מיידי בשעות הפעילות.',
      'אל תנסה לסגור בעצמך.',
    ],
    forbidden: [],
    allowedNextStatuses: ['human_handoff'],
  },
  {
    name: 'opt_out',
    trigger: 'lead asks to stop / remove',
    objective: 'לעצור באופן סופי וברור.',
    guidance: [
      'אישור קצר וצנוע.',
      'בלי ניסיון נוסף לשחזר את השיחה.',
    ],
    forbidden: ['ניסיון נוסף לשכנוע'],
    allowedNextStatuses: ['do_not_contact', 'removed_by_request'],
  },
];

const stopWords = ['לא מעוניין', 'תסיר', 'להסיר', 'תפסיק', 'stop', 'unsubscribe'];
const phoneWords = ['התקשר', 'שיחה טלפונית', 'תתקשר', 'דבר איתי', 'נציג', 'בן אדם'];
const priceWords = ['מחיר', 'כמה עולה', 'עלות', 'תשלום', 'תקציב'];

export interface PlaybookSelectionInput {
  inboundText: string;
  leadStatus: string;
  source: string;
  paymentStatus: string | null;
  hoursSinceLastInbound: number | null;
  freeAdviceCount: number;
  inferredIntent?:
    | 'question'
    | 'objection'
    | 'buy_signal'
    | 'escalation_request'
    | 'chit_chat'
    | 'dnc_request'
    | 'unclear';
  intentConfidence?: 'high' | 'medium' | 'low';
}

export function selectPlaybook(input: PlaybookSelectionInput): Playbook {
  const lower = input.inboundText.toLowerCase();
  const has = (words: string[]) => words.some((w) => lower.includes(w.toLowerCase()));

  const intent = input.inferredIntent;
  const conf = input.intentConfidence ?? 'low';
  if (intent === 'dnc_request' && conf !== 'low') return byName('opt_out');
  if (intent === 'escalation_request' && conf !== 'low') return byName('phone_request');
  if (intent === 'buy_signal' && conf === 'high') {
    return byName(input.leadStatus === 'qualified' ? 'checkout_push' : 'qualification');
  }

  if (has(stopWords)) return byName('opt_out');
  if (has(phoneWords)) return byName('phone_request');
  if (input.leadStatus === 'payment_pending') return byName('payment_pending_rescue');
  if (has(priceWords) || intent === 'objection') return byName('price_objection');
  if (input.freeAdviceCount >= 3) return byName('free_advice_boundary');

  if (input.leadStatus === 'qualified') return byName('checkout_push');
  if (['first_contact_sent', 'responded', 'nurture'].includes(input.leadStatus)) return byName('qualification');

  if (input.leadStatus === 'new') {
    if (['whatsapp', 'instagram_dm'].includes(input.source)) {
      return byName('first_contact_whatsapp_inbound');
    }
    return byName('first_contact_form_lead');
  }
  return byName('qualification');
}

function byName(name: string): Playbook {
  const p = PLAYBOOKS.find((p) => p.name === name);
  if (!p) throw new Error(`Unknown playbook: ${name}`);
  return p;
}
