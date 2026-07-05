import { useEffect, useMemo, useRef } from 'react';
import clsx from 'clsx';
import { EmptyState } from '@/components/EmptyState';
import { formatRelative } from '@/lib/format';
import type { ActivityRow } from '@/lib/types';

// Tier 0.F.1 — the Universal Record Screen's heart. ONE chronological
// feed for every activity attached to a contact, replacing the four
// separate panes (Transcript, Events, Tasks, Queue) the operator used
// to scan. Renders all seven activity_type values produced by the
// migration-054 triggers; unknown types fall back to a slim event row
// so future activity kinds added in Tier 1+ render gracefully instead
// of being invisible.

interface UnifiedTimelineProps {
  activities: ActivityRow[];
  /** Optional className for the scroll container — used to harmonise
   *  with the existing lead-detail layout that constrained the
   *  legacy Transcript. */
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

// Noisy system events that add no operator signal in the unified feed:
// duplicate inbound receipts (already a message bubble), provider status
// pings, router menu prompts, and the AI-handback churn. Nothing is
// deleted — these rows still live in lead_events; they're just hidden
// from the timeline. Tier: broadcast-handoff §3.6.
const HIDDEN_EVENT_TYPES = new Set<string>([
  'inbound_message_received',
  'provider_message_status_updated',
  'whatsapp_router_prompted',
  'manual_return_to_ai',
]);

// Hebrew labels for the event types that DO stay visible. Unmapped types
// fall back to their raw name so a newly-added event is never invisible.
const EVENT_LABELS: Record<string, string> = {
  intake_received: 'ליד נקלט',
  payment_completed: 'תשלום הושלם',
  sla_breach: 'חריגת SLA',
  queue_resolved: 'פריט תור נסגר',
  human_reply_sent: 'נשלחה תשובה אנושית',
  pending_manual_reply_sent: 'תשובה ידנית נשלחה',
  manual_reply_queued_template_missing: 'תשובה ידנית ממתינה (חסרה תבנית)',
  engine_internal_note: 'הערת מערכת',
  webinar_event_received: 'אירוע וובינר',
  email_inbound_received: 'מייל נכנס',
  whatsapp_router_routed: 'נותב בוואטסאפ',
  whatsapp_router_human_requested: 'התבקש נציג אנושי',
  ai_suppressed_human_owner: 'AI הושתק — בעלות אנושית',
};

// One rendered row: an activity plus how many identical consecutive
// events it stands in for (1 for everything that isn't a folded run).
interface DisplayItem {
  activity: ActivityRow;
  count: number;
}

function eventLabel(activity: ActivityRow): string {
  const raw = activity.title || activity.activity_type;
  return EVENT_LABELS[raw] ?? raw;
}

export function UnifiedTimeline({ activities, className }: UnifiedTimelineProps) {
  const visible = useMemo(
    () => activities.filter((a) => !(a.activity_type === 'event' && HIDDEN_EVENT_TYPES.has(a.title || ''))),
    [activities],
  );
  const grouped = useMemo(() => groupByDay(visible), [visible]);
  const bottomRef = useRef<HTMLLIElement | null>(null);

  // WhatsApp-style "stick to bottom" behaviour — the operator expects
  // new inbound + outbound to park them at the latest item, same as
  // the legacy Transcript did. Triggers on count growth so realtime
  // invalidation lands smoothly.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'auto' });
  }, [activities.length]);

  if (activities.length === 0) {
    return (
      <EmptyState
        icon="📋"
        title="עוד אין פעילות לאיש הקשר"
        hint="הודעות, פגישות, משימות ואירועי מערכת יופיעו כאן באופן כרונולוגי."
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
            {items.map(({ activity, count }) => (
              <ActivityRowView key={activity.id} activity={activity} count={count} />
            ))}
          </ul>
        </li>
      ))}
      <li ref={bottomRef} aria-hidden="true" className="h-px" />
    </ol>
  );
}

function ActivityRowView({ activity, count = 1 }: { activity: ActivityRow; count?: number }) {
  switch (activity.activity_type) {
    case 'message':
      return <MessageBubble activity={activity} />;
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

function MessageBubble({ activity }: { activity: ActivityRow }) {
  const providerStatus = (activity.payload as { provider_status?: string } | null)?.provider_status ?? null;
  const failed = providerStatus === 'failed';
  const base = 'rounded-2xl p-3 max-w-[85%] shadow-sm';
  const ring = failed ? ' ring-1 ring-rose-300' : '';
  const bubble =
    activity.direction === 'inbound' ? `${base} bg-slate-100 mr-auto${ring}` :
    activity.actor_type === 'ai' ? `${base} bg-brand-50 ms-auto${ring}` :
    `${base} bg-amber-50 ms-auto${ring}`;

  return (
    <li className={bubble}>
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="font-medium text-slate-700">{ACTOR_LABELS[activity.actor_type] ?? activity.actor_type}</span>
        <span>·</span>
        <span title={activity.occurred_at}>{formatRelative(activity.occurred_at)}</span>
        {providerStatus ? <span className="text-[10px] uppercase tracking-wide text-slate-400">{providerStatus}</span> : null}
      </div>
      <div className="mt-1 whitespace-pre-wrap text-sm">
        {activity.body || '—'}
      </div>
    </li>
  );
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
  // Events are signal, not content — kept visually quiet so the
  // operator's eye scans past unless they're looking for system
  // history. The Hebrew label carries the meaning; a folded run of the
  // same event shows a ×N badge instead of N identical rows.
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

function groupByDay(activities: ActivityRow[]): Array<{ day: string; items: DisplayItem[] }> {
  // Sort ascending so the bottom-ref scroll behaviour lands at the
  // newest activity — the input is descending from the API.
  const sorted = [...activities].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const groups = new Map<string, ActivityRow[]>();
  for (const activity of sorted) {
    const ts = Date.parse(activity.occurred_at);
    const key = Number.isFinite(ts) ? DAY_FORMATTER.format(new Date(ts)) : '—';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(activity);
  }
  return Array.from(groups.entries()).map(([day, items]) => ({ day, items: collapseRuns(items) }));
}

// Fold consecutive identical events (same event type) into one row with a
// count. Only 'event' rows collapse — messages/tasks/etc. always stand
// alone. Keeps the most-recent occurrence as the representative row so its
// timestamp reflects the latest of the run.
function collapseRuns(items: ActivityRow[]): DisplayItem[] {
  const out: DisplayItem[] = [];
  for (const activity of items) {
    const prev = out[out.length - 1];
    if (
      prev &&
      activity.activity_type === 'event' &&
      prev.activity.activity_type === 'event' &&
      (prev.activity.title || '') === (activity.title || '')
    ) {
      prev.count += 1;
      prev.activity = activity; // keep latest timestamp
    } else {
      out.push({ activity, count: 1 });
    }
  }
  return out;
}
