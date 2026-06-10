// Display helpers. Hebrew labels for enum values used across the operator UI.

import type { LeadHeat, LeadStatus, MeetingRow, OwnershipMode } from './types';

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
  mia_active: 'מיה',
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
