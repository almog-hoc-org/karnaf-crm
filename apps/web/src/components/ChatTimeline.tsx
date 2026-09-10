import { useEffect, useMemo, useRef } from 'react';
import clsx from 'clsx';
import { EmptyState } from '@/components/EmptyState';
import { formatRelative } from '@/lib/format';
import type { ConversationRow, MessageRow } from '@/lib/types';

// The conversation pane of the lead screen: customer / bot / rep message
// bubbles ONLY, in WhatsApp style. Everything the system does around the
// conversation (events, tasks, queue items) lives in ActivityFeed.tsx
// behind the "פעילות" tab — the rep reads a clean chat, not the machinery.
//
// This renders `messages` — the source of truth — NOT the `activities`
// mirror. It used to read the mirror, and that made the transcript
// disappear: sla-worker logged an unconditional `sla_breach` event every
// 10 minutes per stuck lead, each event mirrored into `activities`, and
// lead-detail returns only the newest 400 activity rows. Within three days
// a lead's real messages were pushed out of that window and the pane
// rendered "no messages yet" over a full WhatsApp history. The mirror is
// a derived, lossy view; the chat now reads the table the messages are
// actually written to.

interface ChatTimelineProps {
  messages: MessageRow[];
  // Only used to label bubbles when a lead has more than one channel;
  // omit for single-conversation leads.
  conversations?: ConversationRow[];
  // Set when the last fetch failed. Without it an outage is indistinguishable
  // from a quiet lead, and "עוד אין הודעות" over a real transcript is exactly
  // the lie that sent the owner looking for a bug in the wrong place.
  loadFailed?: boolean;
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
};

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'וואטסאפ',
  instagram: 'אינסטגרם',
  email: 'מייל',
  sms: 'SMS',
};

export function ChatTimeline({ messages, conversations, loadFailed = false, className }: ChatTimelineProps) {
  // A lead can hold both a WhatsApp and an Instagram thread; without a
  // marker the two interleave into one indistinguishable transcript.
  const channelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of conversations ?? []) map.set(c.id, c.channel);
    return map;
  }, [conversations]);
  const showChannel = (conversations?.length ?? 0) > 1;

  const grouped = useMemo(() => groupByDay(messages), [messages]);
  const listRef = useRef<HTMLOListElement | null>(null);

  // WhatsApp-style "stick to bottom" — but ONLY the chat container.
  // scrollIntoView scrolled every ancestor including the page, so the
  // 5s poll yanked the operator's viewport back to the chat while they
  // were filling forms elsewhere on the card. Also: don't jump when the
  // operator has deliberately scrolled up into history.
  const didInitialScroll = useRef(false);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (!didInitialScroll.current || nearBottom) {
      el.scrollTop = el.scrollHeight;
      didInitialScroll.current = true;
    }
  }, [messages.length]);

  if (messages.length === 0) {
    // Three genuinely different situations, three different things to do
    // about them. Collapsing them into one "no messages yet" is what made
    // a data-loading failure look like an untouched lead.
    if (loadFailed) {
      return (
        <EmptyState
          icon="⚠️"
          title="לא הצלחנו לטעון את השיחה"
          hint="זו תקלת טעינה, לא שיחה ריקה. המערכת ממשיכה לנסות — אפשר גם לרענן את הדף."
        />
      );
    }
    if ((conversations?.length ?? 0) === 0) {
      return (
        <EmptyState
          icon="📭"
          title="עוד לא נפתחה שיחה מול הליד"
          hint="הליד נקלט אך טרם התכתב איתנו. ברגע שתישלח או תתקבל הודעה ראשונה היא תופיע כאן."
        />
      );
    }
    return (
      <EmptyState
        icon="💬"
        title="השיחה פתוחה אך עדיין ריקה"
        hint="הודעות וואטסאפ של הלקוח, הבוט והנציג יופיעו כאן."
      />
    );
  }

  return (
    <ol ref={listRef} className={clsx('mt-3 max-h-[60vh] space-y-3 overflow-auto pr-1 sm:max-h-[36rem]', className)}>
      {grouped.map(({ day, items }) => (
        <li key={day}>
          <div className="my-1 flex items-center gap-3">
            <span className="h-px flex-1 bg-slate-200" />
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">{day}</span>
            <span className="h-px flex-1 bg-slate-200" />
          </div>
          <ul className="space-y-2">
            {items.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                channel={showChannel ? channelById.get(message.conversation_id) ?? null : null}
              />
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function MessageBubble({ message, channel }: { message: MessageRow; channel: string | null }) {
  const failed = message.provider_status === 'failed';
  const base = 'rounded-2xl p-3 max-w-[85%] shadow-sm';
  const ring = failed ? ' ring-1 ring-rose-300' : '';
  const bubble =
    message.direction === 'inbound' ? `${base} bg-slate-100 mr-auto${ring}` :
    message.sender_type === 'ai' ? `${base} bg-brand-50 ms-auto${ring}` :
    `${base} bg-amber-50 ms-auto${ring}`;

  // A media message often carries no text at all; without a placeholder
  // it rendered as an empty bubble that looked like a bug.
  const text = message.content_text?.trim();
  const body = text
    ? text
    : message.message_type === 'media' ? '📎 קובץ מדיה — לפתוח בוואטסאפ'
    : message.message_type === 'template' ? '📄 נשלחה תבנית'
    : '—';

  return (
    <li className={bubble}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span className="font-medium text-slate-700">
          {ACTOR_LABELS[message.sender_type] ?? message.sender_type}
        </span>
        <span>·</span>
        <span title={message.created_at}>{formatRelative(message.created_at)}</span>
        {channel ? (
          <span className="rounded bg-white/70 px-1.5 text-[10px]">{CHANNEL_LABELS[channel] ?? channel}</span>
        ) : null}
        {message.provider_status ? (
          <span className="text-[10px] uppercase tracking-wide text-slate-400">{message.provider_status}</span>
        ) : null}
      </div>
      <div className={clsx('mt-1 whitespace-pre-wrap text-sm', !text && 'text-slate-500')}>{body}</div>
      {failed && message.provider_error ? (
        <div className="mt-1 text-[11px] text-rose-700">שגיאת שליחה: {message.provider_error}</div>
      ) : null}
    </li>
  );
}

function groupByDay(messages: MessageRow[]): Array<{ day: string; items: MessageRow[] }> {
  const sorted = [...messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const groups = new Map<string, MessageRow[]>();
  for (const message of sorted) {
    const ts = Date.parse(message.created_at);
    const key = Number.isFinite(ts) ? DAY_FORMATTER.format(new Date(ts)) : '—';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(message);
  }
  return Array.from(groups.entries()).map(([day, items]) => ({ day, items }));
}
