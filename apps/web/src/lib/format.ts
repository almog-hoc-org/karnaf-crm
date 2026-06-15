// Display helpers. Hebrew labels for enum values used across the operator UI.
//
// Tier 7.C.1 — single source of truth for every status / stage / domain
// label set. Pages must import from here rather than declaring a local
// copy: the audit found 6+ pages with overlapping LOCAL `STATUS_LABELS`
// constants. Drift between them is silent — a server enum widens and
// one page renders raw English while another stays consistent.

import type { LeadHeat, LeadStatus, MeetingRow, OwnershipMode } from './types';

// Tier 7.C.1 — fallback formatter for unknown enum values. When a
// server enum widens between a deploy and the next frontend rebuild,
// the raw value would otherwise leak (e.g. `qualification_v2`). This
// helper produces "Qualification V2" — readable, signal to the
// operator that the label is auto-generated.
export function titleizeEnum(raw: string): string {
  return raw
    .split(/[_\s]+/u)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Generic lookup helper: returns the labeled value or a titleized
// fallback. Use this when the dictionary keys are stable but new
// values may appear.
export function labelOr(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return '—';
  return map[key] ?? titleizeEnum(key);
}

export const STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'חדש',
  first_contact_sent: 'נשלחה הודעה ראשונה',
  responded: 'הגיב',
  qualified: 'הוסמך',
  nurture: 'בחימום',
  checkout_pushed: 'נשלח קישור רכישה',
  payment_pending: 'תשלום בתהליך',
  human_handoff: 'הועבר לאדם',
  won: 'נסגר ברכישה',
  lost: 'אבד',
  dormant: 'רדום',
  onboarding_active: 'באונבורדינג',
  active_student: 'תלמיד פעיל',
  do_not_contact: 'לא ליצור קשר',
  removed_by_request: 'הוסר לבקשתו',
  duplicate: 'כפילות',
  manual_review_required: 'דורש בדיקה ידנית',
};

export const HEAT_LABELS: Record<LeadHeat, string> = {
  hot: 'חם',
  warm: 'פושר',
  cool: 'צונן',
  cold: 'קר',
};

export const OWNERSHIP_LABELS: Record<OwnershipMode, string> = {
  ai_active: 'AI פעיל',
  mia_active: 'נציג',
  phone_sales_pending: 'ממתין לשיחת טלפון',
  shared_watch: 'במעקב משותף',
  suppressed: 'מושתק',
};

export const MEETING_TYPE_LABELS: Record<MeetingRow['meeting_type'], string> = {
  phone: 'טלפון',
  zoom: 'זום',
  office: 'משרד',
};

export const MEETING_STATUS_LABELS: Record<MeetingRow['status'], string> = {
  scheduled: 'מתוכננת',
  held: 'התקיימה',
  cancelled: 'בוטלה',
  no_show: 'לא הגיע',
};

// Tier 5.E.2 — single source for product labels. Was duplicated
// (with minor copy drift) in LeadDetailPage + InboxPage. Drift here
// is silent: a value used in one place might display as "כלי
// תלמידים" and in another as "כלי תלמידים / לקוח קיים". This map
// is the truth; pages import from here.
export const PRODUCT_LABELS: Record<string, string> = {
  digital_program: 'תוכנית הדרך לדירה',
  investor_mentorship: 'ליווי משקיעים',
  contractor_group_purchase: 'קבוצת רכישה מקבלן',
  personal_consultation: 'שיחת ייעוץ אישית',
  // Legacy keys from the first classifier version, kept so old DB
  // rows still render with a Hebrew label.
  mentorship: 'ליווי משקיעים',
  student_tools: 'כלי תלמידים / לקוח קיים',
  financing_guidance: 'הכוונת מימון',
  unknown: 'לא ידוע',
};

// AI playbook stage → Hebrew label. The 9 names come from
// supabase/functions/_shared/playbooks.ts (the source of truth that
// orchestrate-message writes to lead.ai_playbook_stage). If you add
// a playbook there, add a label here — otherwise the raw English
// snake_case leaks to the operator UI on LeadDetailPage.
export const AI_PLAYBOOK_STAGE_LABELS: Record<string, string> = {
  first_contact_whatsapp_inbound: 'מענה ראשון — WhatsApp/IG',
  first_contact_form_lead: 'מענה ראשון — טופס',
  qualification: 'איתור צרכים',
  price_objection: 'התנגדות מחיר',
  free_advice_boundary: 'גבול ייעוץ חינמי',
  checkout_push: 'דחיפה לרכישה',
  payment_pending_rescue: 'חילוץ תשלום ממתין',
  phone_request: 'בקשה לשיחה',
  opt_out: 'בקשת הסרה',
};

// Tier 7.C.1 — entity status / domain / type labels, centralized.
// Each was previously a local const in its consuming page; drift
// between pages was easy and silent. Importers should use these
// exports + labelOr() wrapping for new server enum values.

// Lead/Deal status (canonical pipeline) lives in STATUS_LABELS above.

export const DEAL_STATUS_LABELS: Record<string, string> = {
  open: 'פתוח',
  won: 'נסגר בהצלחה',
  lost: 'לא רלוונטי',
  cancelled: 'בוטל',
};

export const DEAL_STAGE_LABELS: Record<string, string> = {
  new: 'ליד חדש',
  webinar_registered: 'נרשם לוובינר',
  webinar_attended: 'השתתף בוובינר',
  phone_call_booked: 'קבע שיחת טלפון',
  form_submitted: 'מילא טופס',
  zoom_meeting: 'פגישת זום',
  office_meeting: 'פגישה במשרד',
  phone_call_done: 'בוצעה שיחה',
  meeting_scheduled: 'תואמה פגישה',
  office_meeting_held: 'פגישה התקיימה',
  signed: 'חתם',
  shahar_phone_call_done: 'בוצעה שיחה (שחר)',
  paid_program_member: 'שילם — חבר תכנית',
  closed_won: 'נסגר',
  not_relevant: 'לא רלוונטי',
};

export const PRD_TRACK_LABELS: Record<string, string> = {
  program: 'תכנית הליווי',
  presale: 'פריסייל / חתימה',
  investor_mentorship: 'ליווי משקיעים',
};

export const PARTNER_STATUS_LABELS: Record<string, string> = {
  active: 'פעיל',
  paused: 'מושהה',
  archived: 'בארכיון',
};

export const PARTNER_DOMAIN_LABELS: Record<string, string> = {
  investor_mentorship: 'ליווי משקיעים',
  appraisal: 'שמאות',
  legal: 'משפטי',
  financing: 'מימון',
  other: 'אחר',
};

export const PROJECT_TYPE_LABELS: Record<string, string> = {
  residential: 'מגורים',
  commercial: 'מסחרי',
  mixed: 'משולב',
};

export const PROJECT_STATUS_LABELS: Record<string, string> = {
  recruiting: 'בגיוס',
  closed: 'סגור לגיוס',
  executed: 'נסגר ובוצע',
  cancelled: 'בוטל',
};

export const COMMISSION_STATUS_LABELS: Record<string, string> = {
  pending: 'ממתינה',
  to_bill: 'לחיוב',
  paid: 'שולמה',
  cancelled: 'בוטלה',
};

export const TEMPLATE_STATUS_LABELS: Record<string, string> = {
  draft: 'טיוטה',
  active: 'פעיל',
  deprecated: 'הוצא משימוש',
};

export const TEMPLATE_CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'וואטסאפ',
  sms: 'SMS',
  email: 'מייל',
};

export const JOURNEY_RUN_STATUS_LABELS: Record<string, string> = {
  active: 'פעיל',
  completed: 'הסתיים',
  cancelled: 'בוטל',
  failed: 'נכשל',
};

export const PROGRAM_PROGRESS_LABELS: Record<string, string> = {
  joined: 'הצטרף',
  // Extend as program states are introduced.
};

// Lead arrival-source → short Hebrew label (1–2 words), by channel.
// Mirrors the lead_sources registry display names. Use via
// labelOr(SOURCE_LABELS, lead.source) so an unregistered slug still
// renders titleized rather than raw snake_case.
export const SOURCE_LABELS: Record<string, string> = {
  website: 'אתר',
  landing_page: 'אתר',
  services_page: 'אתר',
  webinar: 'וובינר',
  webinar_registration: 'וובינר',
  responder_form: 'רב מסר',
  lead_magnet: 'מגנט לידים',
  instagram: 'אינסטגרם',
  instagram_dm: 'אינסטגרם',
  facebook_lead_ads: 'פייסבוק',
  facebook_lead_ad: 'פייסבוק',
  facebook_messenger: 'מסנג׳ר',
  whatsapp: 'וואטסאפ',
  whatsapp_direct: 'וואטסאפ',
  whatsapp_topic_selection: 'וואטסאפ',
  phone_call_request: 'בקשת שיחה',
  presale_form: 'פריסייל',
  investor_mentorship_form: 'ליווי משקיעים',
  manual_entry: 'הזנה ידנית',
  screenshot_manual: 'צילום מסך',
  unknown: 'לא ידוע',
};

export const QUEUE_LABELS: Record<string, string> = {
  first_response_due: 'מענה ראשוני',
  hot_lead: 'ליד חם',
  sla_risk: 'סיכון SLA',
  human_handoff: 'העברת ליד לאדם',
  payment_pending: 'ממתין לתשלום',
  phone_escalation: 'מועמד לשיחה',
  nurture_due: 'חימום מתוזמן',
  dormant_review: 'ליד רדום',
  failed_automation: 'אוטומציה כשלה',
  weekend_carryover: 'העברה לאחרי סוף שבוע',
  low_fit_cleanup: 'ניקוי לידים לא מתאימים',
  manual_review_required: 'בדיקה ידנית',
  ai_stuck: 'AI תקוע',
  whatsapp_topic_unselected: 'וואטסאפ — לא בחר נושא',
  whatsapp_human_requested: 'וואטסאפ — ביקש נציג',
  presale_followup_due: 'פריסייל — טיפול נציג',
  investor_followup_due: 'ליווי משקיעים — טיפול שחר',
  webinar_registered: 'נרשם לוובינר',
  webinar_attended_not_purchased: 'וובינר — השתתף ולא רכש',
  webinar_no_show: 'וובינר — לא השתתף',
};

export function heatBadgeClass(heat: LeadHeat | string): string {
  switch (heat) {
    case 'hot': return 'kf-badge kf-badge-hot';
    case 'warm': return 'kf-badge kf-badge-warm';
    case 'cool': return 'kf-badge kf-badge-cool';
    case 'cold': return 'kf-badge kf-badge-cold';
    default: return 'kf-badge kf-badge-mute';
  }
}

const dtf = new Intl.DateTimeFormat('he-IL', {
  dateStyle: 'short',
  timeStyle: 'short',
});

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return '—';
  return dtf.format(new Date(ts));
}

export function formatRelative(value: string | null | undefined, now = Date.now()): string {
  if (!value) return '—';
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return '—';
  const diffMs = now - ts;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'הרגע';
  if (minutes < 60) return `לפני ${minutes} ד׳`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `לפני ${hours} שעות`;
  const days = Math.round(hours / 24);
  return `לפני ${days} ימים`;
}
