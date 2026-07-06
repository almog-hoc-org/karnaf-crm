import { useMemo } from 'react';
import clsx from 'clsx';
import { EmptyState } from '@/components/EmptyState';
import { formatRelative } from '@/lib/format';
import type { ActivityRow } from '@/lib/types';

// The "פעילות" tab of the lead screen: everything that is NOT a chat
// message — lead_events, tasks, queue items, meetings, calls, notes.
// Moved out of the conversation pane so the rep reads a clean chat;
// here every slug gets a Hebrew label, unknown slugs get a readable
// fallback (never a bare English slug), and consecutive repeats
// collapse to one row with an ×N badge.

interface ActivityFeedProps {
  activities: ActivityRow[];
  className?: string;
}

const DAY_FORMATTER = new Intl.DateTimeFormat('he-IL', {
  weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
});

const ACTOR_LABELS: Record<string, string> = {
  lead: 'הלקוח',
  ai: 'AI',
  mia: 'נציג',
  sales_rep: 'איש מכירות',
  system: 'המערכת',
  admin: 'אדמין',
  provider: 'ספק',
  human: 'אנושי',
};

// Pure spam that adds nothing even in the activity view: delivery-status
// pings and the event that mirrors every inbound bubble.
const HIDDEN_EVENT_TYPES = new Set<string>([
  'inbound_message_received',
  'provider_message_status_updated',
]);

// Hebrew for every event slug the backend logs (grep logLeadEvent +
// lead_events inserts). Keep additions here when new slugs land.
const EVENT_TYPE_LABELS: Record<string, string> = {
  // Conversation / replies
  ai_reply_sent: 'הבוט השיב ללקוח',
  human_reply_sent: 'נשלחה תשובת נציג',
  internal_reply_sent: 'נשלחה תשובה פנימית',
  pending_manual_reply_sent: 'תשובה שהמתינה נשלחה',
  manual_reply_queued_after_24h: 'תשובה ממתינה (מחוץ לחלון 24ש)',
  manual_reply_queued_template_missing: 'תשובה ממתינה (תקלה בתבנית)',
  ai_suppressed_human_owner: 'הבוט הושתק — נציג מטפל',
  conversation_claimed_by_operator: 'נציג לקח את השיחה',
  conversation_released_by_operator: 'נציג שחרר את השיחה',
  // Member concierge
  member_concierge_greeted: 'נשלחה קבלת פנים לחבר תוכנית',
  member_concierge_reprompted: 'נשלחה תזכורת לחבר תוכנית',
  member_expert_requested: 'חבר תוכנית ביקש מומחה',
  program_member_marked: 'סומן כחבר תוכנית',
  portal_invite_issued: 'הונפקה הזמנה לפורטל',
  // Automations / journeys / templates
  automation_template_sent: 'נשלחה תבנית אוטומטית',
  lifecycle_template_sent: 'נשלחה הודעת ליווי',
  journey_started: 'מסע לקוח התחיל',
  lead_journey_classified: 'הליד סווג למסע',
  engine_internal_note: 'הערת מנוע אוטומציה',
  email_list_added: 'נוסף לרשימת דיוור',
  // Lifecycle / manual actions
  lead_created: 'ליד נוצר',
  lead_manual_created: 'ליד נוצר ידנית',
  lead_manual_updated: 'ליד עודכן ידנית',
  lead_manual_restored: 'ליד שוחזר',
  lead_manual_soft_deleted: 'ליד הוסר',
  lead_meta_updated: 'פרטי הליד עודכנו',
  manual_assign_to_mia: 'הועבר לטיפול נציג',
  manual_return_to_ai: 'הוחזר למענה אוטומטי',
  manual_mark_won: 'סומן כעסקה שנסגרה',
  manual_mark_lost: 'סומן כאבוד',
  manual_mark_dnc: 'סומן לא ליצור קשר',
  manual_phone_escalation: 'סומן לשיחת טלפון',
  manual_reopen_lead: 'השיחה נפתחה מחדש',
  manual_stage_change: 'שלב העסקה עודכן',
  // Payments / deals
  payment_completed: 'תשלום הושלם',
  // Meetings / calls
  meeting_scheduled: 'נקבעה פגישה',
  phone_call_logged: 'תועדה שיחת טלפון',
  // Ops / SLA / routing
  sla_breach: 'חריגת זמן מענה',
  queue_resolved: 'משימה נסגרה',
  intake_received: 'התקבלה פנייה',
  webinar_event_received: 'אירוע וובינר',
  email_inbound_received: 'התקבל מייל',
  whatsapp_router_prompted: 'נשלח תפריט נושאים',
  whatsapp_router_routed: 'נבחר נושא שיחה',
  whatsapp_router_human_requested: 'ביקש נציג אנושי',
  // Debug / replay
  ai_replay: 'הרצה חוזרת של הבוט',
  ai_replay_completed: 'הרצה חוזרת הסתיימה',
  summary_refreshed: 'סיכום השיחה עודכן',
};

function eventLabel(activity: ActivityRow): string {
  const key = activity.title ?? activity.activity_type;
  // Never render a bare English slug — unknown types get a readable
  // wrapper so new backend slugs degrade gracefully.
  return EVENT_TYPE_LABELS[key] ?? `אירוע מערכת · ${key}`;
}

export function ActivityFeed({ activities, className }: ActivityFeedProps) {
  const visible = useMemo(
    () =>
      activities.filter(
        (a) =>
          a.activity_type !== 'message' &&
          !(a.activity_type === 'event' && HIDDEN_EVENT_TYPES.has(a.title ?? '')),
      ),
    [activities],
  );
  const grouped = useMemo(() => groupByDay(visible), [visible]);

  if (visible.length === 0) {
    return (
      <EmptyState
        icon="📋"
        title="עוד אין פעילות מערכת"
        hint="אוטומציות, משימות, פגישות ואירועי מערכת יופיעו כאן."
      />
    );
  }

  return (
    <ol className={clsx('mt-3 max-h-[60vh] space-y-3 overflow-auto pr-1 sm:max-h-[36rem]', className)}>
      {grouped.map(({ day, items }) => (
        <li key={day}>
          <div className="my-1 flex items-center gap-3">
            <span className="h-px flex-1 bg-slate-200" />
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">{day}</span>
            <span className="h-px flex-1 bg-slate-200" />
          </div>
          <ul className="space-y-2">
            {collapseConsecutiveEvents(items).map((unit) => (
              <ActivityRowView key={unit.activity.id} activity={unit.activity} count={unit.count} />
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function ActivityRowView({ activity, count = 1 }: { activity: ActivityRow; count?: number }) {
  switch (activity.activity_type) {
    case 'task':
    case 'queue_item':
      return <ActionCard activity={activity} />;
    case 'meeting':
      return <MeetingCard activity={activity} />;
    case 'call_log':
      return <CallCard activity={activity} />;
    case 'note':
      return <NoteCard activity={activity} />;
    case 'event':
    default:
      return <EventLine activity={activity} count={count} />;
  }
}

// Collapse runs of the same consecutive event (same title) into a single
// row with an "×N" badge.
function collapseConsecutiveEvents(items: ActivityRow[]): Array<{ activity: ActivityRow; count: number }> {
  const units: Array<{ activity: ActivityRow; count: number }> = [];
  for (const activity of items) {
    const last = units[units.length - 1];
    if (
      last &&
      activity.activity_type === 'event' &&
      last.activity.activity_type === 'event' &&
      (last.activity.title ?? '') === (activity.title ?? '')
    ) {
      last.count += 1;
      last.activity = activity; // keep the most recent timestamp
    } else {
      units.push({ activity, count: 1 });
    }
  }
  return units;
}

function ActionCard({ activity }: { activity: ActivityRow }) {
  const isOpen = activity.status === 'open' || activity.status === 'pending' || activity.status === 'claimed';
  const isDone = activity.status === 'done' || activity.status === 'resolved';
  const icon = activity.activity_type === 'queue_item' ? '⚡' : '✅';
  const tone = isOpen ? 'border-amber-300 bg-amber-50' : isDone ? 'border-emerald-200 bg-emerald-50/60' : 'border-slate-200 bg-white';
  const overdueMs = activity.due_at ? Date.parse(activity.due_at) : NaN;
  const overdue = isOpen && Number.isFinite(overdueMs) && overdueMs < Date.now();

  return (
    <li className={clsx('rounded-2xl border p-3 shadow-sm', tone)}>
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span aria-hidden="true">{icon}</span>
        <span className="font-semibold text-slate-700">{activity.title || activity.activity_type}</span>
        {activity.status ? (
          <span className={clsx(
            'rounded-full px-2 py-0.5 text-[10px] font-medium',
            isOpen && 'bg-amber-100 text-amber-800',
            isDone && 'bg-emerald-100 text-emerald-800',
            !isOpen && !isDone && 'bg-slate-100 text-slate-600',
          )}>{activity.status}</span>
        ) : null}
        <span className="ms-auto" title={activity.occurred_at}>{formatRelative(activity.occurred_at)}</span>
      </div>
      {activity.body ? <div className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{activity.body}</div> : null}
      {activity.due_at ? (
        <div className={clsx('mt-1 text-xs', overdue ? 'font-semibold text-rose-700' : 'text-slate-500')}>
          {overdue ? '⚠️ באיחור · ' : '⏳ '}
          יעד: {formatRelative(activity.due_at)}
        </div>
      ) : null}
    </li>
  );
}

function MeetingCard({ activity }: { activity: ActivityRow }) {
  const startsAt = (activity.payload as { starts_at?: string } | null)?.starts_at ?? activity.occurred_at;
  return (
    <li className="rounded-2xl border border-violet-200 bg-violet-50/60 p-3 shadow-sm">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span aria-hidden="true">📅</span>
        <span className="font-semibold text-slate-700">{activity.title || 'פגישה'}</span>
        {activity.status ? <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] text-violet-800">{activity.status}</span> : null}
        <span className="ms-auto" title={startsAt}>{formatRelative(startsAt)}</span>
      </div>
      {activity.body ? <div className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{activity.body}</div> : null}
    </li>
  );
}

function CallCard({ activity }: { activity: ActivityRow }) {
  return (
    <li className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-3 shadow-sm">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span aria-hidden="true">📞</span>
        <span className="font-semibold text-slate-700">{activity.title || 'שיחת טלפון'}</span>
        <span className="ms-auto" title={activity.occurred_at}>{formatRelative(activity.occurred_at)}</span>
      </div>
      {activity.body ? <div className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{activity.body}</div> : null}
    </li>
  );
}

function NoteCard({ activity }: { activity: ActivityRow }) {
  return (
    <li className="rounded-2xl border border-slate-200 bg-yellow-50/40 p-3 shadow-sm">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span aria-hidden="true">📝</span>
        <span className="font-semibold text-slate-700">{activity.title || 'הערה'}</span>
        <span className="ms-auto" title={activity.occurred_at}>{formatRelative(activity.occurred_at)}</span>
      </div>
      {activity.body ? <div className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{activity.body}</div> : null}
    </li>
  );
}

function EventLine({ activity, count = 1 }: { activity: ActivityRow; count?: number }) {
  return (
    <li className="flex items-center gap-2 rounded-full bg-slate-50 px-3 py-1 text-xs text-slate-600 ring-1 ring-slate-200">
      <span aria-hidden="true">●</span>
      <span className="font-medium text-slate-700">{eventLabel(activity)}</span>
      {count > 1 ? (
        <span className="rounded-full bg-slate-200 px-1.5 text-[10px] font-semibold text-slate-600">×{count}</span>
      ) : null}
      <span className="text-slate-400">·</span>
      <span>{ACTOR_LABELS[activity.actor_type] ?? activity.actor_type}</span>
      <span className="ms-auto" title={activity.occurred_at}>{formatRelative(activity.occurred_at)}</span>
    </li>
  );
}

function groupByDay(activities: ActivityRow[]): Array<{ day: string; items: ActivityRow[] }> {
  const sorted = [...activities].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const groups = new Map<string, ActivityRow[]>();
  for (const activity of sorted) {
    const ts = Date.parse(activity.occurred_at);
    const key = Number.isFinite(ts) ? DAY_FORMATTER.format(new Date(ts)) : '—';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(activity);
  }
  return Array.from(groups.entries()).map(([day, items]) => ({ day, items }));
}
