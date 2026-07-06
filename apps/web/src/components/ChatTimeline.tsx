import { useEffect, useMemo, useRef } from 'react';
import clsx from 'clsx';
import { EmptyState } from '@/components/EmptyState';
import { formatRelative } from '@/lib/format';
import type { ActivityRow } from '@/lib/types';

// The conversation pane of the lead screen: customer / bot / rep message
// bubbles ONLY, in WhatsApp style. Everything else the activities feed
// mirrors (lead_events, tasks, queue items, meetings, calls, notes) moved
// to ActivityFeed.tsx behind the "פעילות" tab — the rep reads a clean
// chat, not the machinery.

interface ChatTimelineProps {
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

export function ChatTimeline({ activities, className }: ChatTimelineProps) {
  const messages = useMemo(
    () => activities.filter((a) => a.activity_type === 'message'),
    [activities],
  );
  const grouped = useMemo(() => groupByDay(messages), [messages]);
  const bottomRef = useRef<HTMLLIElement | null>(null);

  // WhatsApp-style "stick to bottom" — new inbound + outbound park the
  // operator at the latest message.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'auto' });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <EmptyState
        icon="💬"
        title="עוד אין הודעות בשיחה"
        hint="הודעות וואטסאפ של הלקוח, הבוט והנציג יופיעו כאן."
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
            {items.map((activity) => (
              <MessageBubble key={activity.id} activity={activity} />
            ))}
          </ul>
        </li>
      ))}
      <li ref={bottomRef} aria-hidden="true" className="h-px" />
    </ol>
  );
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
