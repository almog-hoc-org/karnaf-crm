// Canonical attention-inbox kind registry — the single source the web
// app imports (@lib/view-models/inbox-kinds) and daily-sales-inbox
// mirrors (_shared/inbox-kinds.ts; keep in sync). The RPC (migration
// 105) is the third leg: every kind it can emit MUST appear here — the
// test fails otherwise, instead of new kinds silently bucketing under
// "אחר"/ops.

/** Every kind attention_inbox() can emit (see migration 105). */
export const ATTENTION_KINDS = [
  'awaiting_reply',
  'mia_reply',
  'overdue_action',
  'phone_overdue',
  'phone_escalation',
  'ai_stuck',
  'deal_stalled',
  'meeting_outcome_pending',
  'queue',
] as const;

export type AttentionKind = (typeof ATTENTION_KINDS)[number];
export type WorkLane = 'reply' | 'call' | 'risk' | 'ops';

export const KIND_LABELS: Record<AttentionKind, string> = {
  awaiting_reply: 'ממתין לתשובה',
  mia_reply: 'הלקוח השיב',
  overdue_action: 'פעולה הבאה באיחור',
  phone_overdue: 'שיחת טלפון באיחור',
  phone_escalation: 'הוסלם לטלפון',
  ai_stuck: 'AI תקוע',
  deal_stalled: 'עסקה תקועה',
  meeting_outcome_pending: 'פגישה לסיכום',
  queue: 'משימת תור',
};

export const KIND_LANES: Record<AttentionKind, WorkLane> = {
  awaiting_reply: 'reply',
  mia_reply: 'reply',
  overdue_action: 'risk',
  phone_overdue: 'call',
  phone_escalation: 'call',
  ai_stuck: 'risk',
  deal_stalled: 'risk',
  meeting_outcome_pending: 'ops',
  queue: 'ops',
};

/** Safe accessors for untyped kinds coming off the wire. */
export function kindLabel(kind: string): string {
  return (KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

export function kindLane(kind: string): WorkLane {
  return (KIND_LANES as Record<string, WorkLane>)[kind] ?? 'ops';
}
