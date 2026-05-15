import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  fetchLeadDetail, postAdminAction, postSendReply, postQueueResolve,
  type AdminAction, type CallOutcome, type LeadMetaUpdates,
} from '@/lib/api';
import { HeatBadge, OwnershipBadge, StatusBadge } from '@/components/Badge';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { t } from '@/lib/i18n';
import { QUEUE_LABELS, formatDateTime, formatRelative } from '@/lib/format';
import type { MessageRow } from '@/lib/types';
import { useAuth } from '@/auth/auth-context';
import { useToast } from '@/components/Toast';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';

export function LeadDetailPage() {
  const { leadId = '' } = useParams<{ leadId: string }>();
  const qc = useQueryClient();
  const auth = useAuth();
  const toast = useToast();
  const detailQ = useQuery({
    queryKey: ['lead-detail', leadId],
    queryFn: () => fetchLeadDetail(leadId),
    enabled: !!leadId,
    // ⚠️ Live-update bug (2026-05-15): without polling, the lead detail
    // loaded ONCE on mount and never refreshed, so inbound WhatsApp messages
    // didn't appear until the operator clicked something else. 5s poll is
    // the floor; realtime invalidation below short-circuits it when a
    // change actually fires. refetchIntervalInBackground stays false so
    // hidden tabs don't burn quota.
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });

  useDocumentTitle(detailQ.data?.lead.full_name || 'ליד');

  // Live updates: subscribe to Postgres changes scoped to THIS lead so the
  // transcript / ownership / queue refreshes within ~1s of the inbound
  // landing in the DB. The filter keeps us from invalidating on every
  // other lead's messages in the same publication. Migration 029 adds the
  // required tables to `supabase_realtime`.
  const leadDetailKey: Array<readonly unknown[]> = [['lead-detail', leadId]];
  useRealtimeInvalidate('messages', leadDetailKey, { filter: `lead_id=eq.${leadId}` });
  useRealtimeInvalidate('leads', leadDetailKey, { filter: `id=eq.${leadId}` });
  useRealtimeInvalidate('work_queue', leadDetailKey, { filter: `lead_id=eq.${leadId}` });
  useRealtimeInvalidate('conversation_claims', leadDetailKey);

  const action = useMutation({
    mutationFn: (input: { action: AdminAction; note?: string; label: string }) =>
      postAdminAction({ action: input.action, leadId, note: input.note ?? null }).then((r) => ({ r, label: input.label })),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['lead-detail', leadId] });
      toast.success(`${data.label} – בוצע`);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const logCall = useMutation({
    mutationFn: (input: { outcome: CallOutcome; durationMinutes: number; note: string | null }) =>
      postAdminAction({
        action: 'log_phone_call',
        leadId,
        callOutcome: input.outcome,
        callDurationMinutes: input.durationMinutes,
        note: input.note,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-detail', leadId] });
      toast.success('שיחת טלפון נרשמה');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const conversationId = detailQ.data?.conversations[0]?.id;

  const sendReply = useMutation({
    mutationFn: (text: string) => {
      if (!conversationId) throw new Error('No conversation');
      return postSendReply({ leadId, conversationId, text });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-detail', leadId] });
      toast.success('הודעה נשלחה');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const resolveQueue = useMutation({
    mutationFn: (input: { queueItemId: string; note?: string }) =>
      postQueueResolve({ queueItemId: input.queueItemId, resolutionNote: input.note ?? null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-detail', leadId] });
      toast.success('פריט תור נסגר');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const [pendingAction, setPendingAction] = useState<
    | { action: AdminAction; note?: string; label: string; description: string; destructive: boolean }
    | null
  >(null);

  const updateMeta = useMutation({
    mutationFn: (updates: LeadMetaUpdates) =>
      postAdminAction({ action: 'update_lead_meta', leadId, metaUpdates: updates }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-detail', leadId] });
      toast.success('עודכן');
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const canEditMeta = auth.role === 'owner' || auth.role === 'admin' || auth.role === 'mia';

  if (detailQ.isLoading) return <p className="text-slate-500">{t('loading')}</p>;
  if (detailQ.error) return <p className="text-rose-600">{t('error_prefix')}: {(detailQ.error as Error).message}</p>;
  if (!detailQ.data) return null;

  const { lead, messages, queueItems, tasks, events } = detailQ.data;

  return (
    <div className="space-y-4">
      <Link to="/leads" className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline">← חזרה לרשימה</Link>

      <header className="kf-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{lead.full_name || 'ליד ללא שם'}</h1>
          <StatusBadge status={lead.lead_status} />
          <HeatBadge heat={lead.lead_heat} />
          <OwnershipBadge ownership={lead.ownership_mode} />
          <span className="kf-badge kf-badge-mute">ציון {lead.lead_score}</span>
          {lead.do_not_contact ? <span className="kf-badge bg-rose-100 text-rose-700">DNC</span> : null}
          {lead.removed_by_request ? <span className="kf-badge bg-rose-100 text-rose-700">הוסר לבקשתו</span> : null}
        </div>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-slate-600 sm:grid-cols-2 lg:grid-cols-3">
          <ContactRow label="טלפון" value={lead.phone} kind="phone" />
          <ContactRow label="אימייל" value={lead.email} kind="email" />
          <DataRow label="מקור" value={lead.source} />
          <DataRow label="נוצר" value={formatDateTime(lead.created_at)} />
          <DataRow label="נכנס לאחרונה" value={formatRelative(lead.last_inbound_at)} />
          <DataRow label="יצא לאחרונה" value={formatRelative(lead.last_outbound_at)} />
        </dl>

        {/* Lifecycle/ownership transitions are restricted server-side to
            owner / admin / mia; hide them for sales_rep so the UI matches. */}
        {auth.role === 'owner' || auth.role === 'admin' || auth.role === 'mia' ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <ActionGroup label="בעלות">
              <button type="button" className="kf-btn" onClick={() => action.mutate({ action: 'assign_to_mia', label: 'הועבר למיה' })}>
                העברה למיה
              </button>
              <button type="button" className="kf-btn" onClick={() => action.mutate({ action: 'return_to_ai', label: 'הוחזר ל-AI' })}>
                החזרה ל-AI
              </button>
              <button type="button" className="kf-btn" onClick={() => action.mutate({ action: 'mark_phone_escalation', label: 'סומן לשיחה' })}>
                סימון לשיחה
              </button>
            </ActionGroup>
            <ActionGroup label="סטטוס">
              <button
                type="button"
                className="kf-btn kf-btn-primary"
                onClick={() => setPendingAction({
                  action: 'mark_won',
                  label: 'נסגר ברכישה',
                  description: 'לסמן את הליד כסגירה ולהפעיל את תהליך האונבורדינג?',
                  destructive: false,
                })}
              >
                סימון כסגירה
              </button>
              <button
                type="button"
                className="kf-btn"
                onClick={() => setPendingAction({
                  action: 'mark_lost',
                  note: 'manual_close',
                  label: 'סומן כאבוד',
                  description: 'לסמן את הליד כאבוד. פעולה זו לא ניתנת לשחזור.',
                  destructive: true,
                })}
              >
                סימון כאבוד
              </button>
            </ActionGroup>
            <ActionGroup label="הסרה">
              <button
                type="button"
                className="kf-btn kf-btn-danger"
                onClick={() => setPendingAction({
                  action: 'mark_dnc',
                  label: 'סומן כ-DNC',
                  description: 'לסמן את הליד כ-Do Not Contact. הבוט יפסיק לפנות אליו ולא יישלחו עוד הודעות.',
                  destructive: true,
                })}
              >
                DNC
              </button>
            </ActionGroup>
          </div>
        ) : null}
        {action.error ? <p className="mt-2 text-sm text-rose-600">{(action.error as Error).message}</p> : null}
      </header>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="kf-card p-4 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">שיחה</h2>
            {lead.phone ? (
              <a
                href={waLink(lead.phone)} target="_blank" rel="noopener noreferrer"
                className="kf-btn kf-btn-ghost text-xs"
                title="פתיחת שיחה ב-WhatsApp"
              >
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                  <path d="M10 2.5a7.5 7.5 0 0 0-6.4 11.4L2.5 17.5l3.7-1.1A7.5 7.5 0 1 0 10 2.5Zm4.4 10.6c-.2.6-1 1.1-1.6 1.2-.4.1-.9.1-3-.7-2.5-1-4.1-3.5-4.2-3.7-.1-.2-1-1.3-1-2.5 0-1.2.6-1.7.9-2 .2-.2.4-.2.6-.2h.4c.1 0 .3 0 .5.4.2.5.7 1.6.7 1.7s.1.2 0 .3c-.1.2-.1.3-.3.4-.1.1-.2.3-.4.4-.1.1-.3.3-.1.5.2.4.7 1.1 1.5 1.8 1 .9 1.8 1.2 2.1 1.3.3.1.5.1.6 0 .2-.2.7-.8.9-1 .2-.3.4-.2.6-.1.3.1 1.7.8 2 .9.3.1.4.2.5.4.1.2.1.7-.1 1.3Z" />
                </svg>
                WhatsApp
              </a>
            ) : null}
          </div>
          <Transcript messages={messages} />
          <ReplyBox
            disabled={!conversationId || lead.do_not_contact || lead.removed_by_request}
            onSend={(text) => sendReply.mutate(text)}
            sending={sendReply.isPending}
            errorMessage={sendReply.error ? (sendReply.error as Error).message : null}
          />
        </div>

        <aside className="space-y-4">
          <div className="kf-card p-4">
            <h2 className="font-semibold">הקשר ליד</h2>
            <dl className="mt-2 space-y-1 text-sm">
              <EditableRow
                k="מטרה"
                v={lead.goal_summary}
                editable={canEditMeta}
                onSave={(next) => updateMeta.mutate({ goal_summary: next })}
              />
              <EditableRow
                k="כאב מרכזי"
                v={lead.pain_point_summary}
                editable={canEditMeta}
                onSave={(next) => updateMeta.mutate({ pain_point_summary: next })}
              />
              <EditableRow
                k="חסם עיקרי"
                v={lead.main_blocker}
                editable={canEditMeta}
                onSave={(next) => updateMeta.mutate({ main_blocker: next })}
              />
              <EditableRow
                k="פעולה הבאה"
                v={lead.next_action_type}
                editable={canEditMeta}
                onSave={(next) => updateMeta.mutate({ next_action_type: next })}
              />
              <Row k="עד" v={lead.next_action_due_at ? formatDateTime(lead.next_action_due_at) : null} />
              <Row k="סטטוס תשלום" v={lead.payment_status} />
            </dl>
          </div>

          <div className="kf-card p-4">
            <h2 className="font-semibold">תורי עבודה</h2>
            {queueItems.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">אין פריטים פתוחים.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {queueItems.map((q) => (
                  <li key={q.id} className="rounded-md bg-slate-50 p-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <strong>{QUEUE_LABELS[q.queue_type] ?? q.queue_type}</strong>
                      <span className="text-xs text-slate-500">{q.status}</span>
                    </div>
                    <div className="text-slate-600">{q.reason || '—'}</div>
                    {(q.status === 'pending' || q.status === 'claimed') ? (
                      <button
                        type="button"
                        className="kf-btn mt-2 text-xs"
                        onClick={() => resolveQueue.mutate({ queueItemId: q.id, note: 'resolved_by_user' })}
                      >
                        סגירה
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {(auth.role === 'sales_rep' || auth.role === 'mia' || auth.role === 'admin' || auth.role === 'owner') ? (
            <div className="kf-card p-4">
              <h2 className="font-semibold">תיעוד שיחת טלפון</h2>
              <CallLogForm
                onSubmit={(outcome, durationMinutes, note) => logCall.mutate({ outcome, durationMinutes, note })}
                submitting={logCall.isPending}
                errorMessage={logCall.error ? (logCall.error as Error).message : null}
              />
            </div>
          ) : null}

          <div className="kf-card p-4">
            <h2 className="font-semibold">משימות</h2>
            {tasks.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">אין משימות.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {tasks.slice(0, 8).map((t) => (
                  <li key={t.id} className="flex items-center justify-between">
                    <span>{t.title}</span>
                    <span className="text-xs text-slate-500">{t.task_status}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="kf-card p-4">
            <h2 className="font-semibold">היסטוריית אירועים</h2>
            <ul className="mt-2 max-h-72 space-y-1 overflow-auto text-xs text-slate-600">
              {events.slice(0, 30).map((e) => (
                <li key={e.id}>
                  <span className="text-slate-400">{formatRelative(e.created_at)}</span>
                  {' '}<strong>{e.event_type}</strong>{' '}<span className="text-slate-500">{e.actor_type}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </section>

      <ConfirmDialog
        open={!!pendingAction}
        title={pendingAction?.label ?? t('destructive_action_title')}
        description={pendingAction?.description ?? t('destructive_action_warning')}
        destructive={pendingAction?.destructive ?? false}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => {
          if (!pendingAction) return;
          action.mutate({ action: pendingAction.action, note: pendingAction.note, label: pendingAction.label });
          setPendingAction(null);
        }}
      />
    </div>
  );
}

function ActionGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/50 p-1.5">
      <span className="w-full px-2 text-xs text-slate-500 sm:w-auto">{label}</span>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string | null | undefined }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <dt className="col-span-1 text-slate-500">{k}</dt>
      <dd className="col-span-2 text-slate-800">{v || '—'}</dd>
    </div>
  );
}

function EditableRow({
  k, v, editable, onSave,
}: {
  k: string;
  v: string | null | undefined;
  editable: boolean;
  onSave: (next: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(v ?? '');

  useEffect(() => {
    if (!editing) setDraft(v ?? '');
  }, [v, editing]);

  if (!editable) return <Row k={k} v={v} />;

  if (!editing) {
    return (
      <div className="grid grid-cols-3 items-center gap-2">
        <dt className="col-span-1 text-slate-500">{k}</dt>
        <dd className="col-span-2 flex items-center gap-2 text-slate-800">
          <span className="min-w-0 flex-1 truncate">{v || '—'}</span>
          <button
            type="button"
            className="text-xs text-brand-700 hover:underline"
            onClick={() => setEditing(true)}
          >
            עריכה
          </button>
        </dd>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-3 items-center gap-2">
      <dt className="col-span-1 text-slate-500">{k}</dt>
      <dd className="col-span-2 flex items-center gap-2">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="kf-input text-sm"
          maxLength={280}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
            if (e.key === 'Enter') {
              const next = draft.trim();
              onSave(next.length ? next : null);
              setEditing(false);
            }
          }}
        />
        <button
          type="button"
          className="kf-btn kf-btn-primary text-xs"
          onClick={() => {
            const next = draft.trim();
            onSave(next.length ? next : null);
            setEditing(false);
          }}
        >
          שמירה
        </button>
        <button
          type="button"
          className="kf-btn text-xs"
          onClick={() => setEditing(false)}
        >
          ביטול
        </button>
      </dd>
    </div>
  );
}

function DataRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-slate-500">{label}:</span>
      <strong className="text-slate-800">{value || '—'}</strong>
    </div>
  );
}

function ContactRow({ label, value, kind }: { label: string; value: string | null | undefined; kind: 'phone' | 'email' }) {
  const toast = useToast();
  if (!value) {
    return (
      <div className="flex items-baseline gap-2">
        <span className="text-slate-500">{label}:</span>
        <strong className="text-slate-800">—</strong>
      </div>
    );
  }
  const href = kind === 'phone' ? `tel:${value}` : `mailto:${value}`;
  function copy() {
    navigator.clipboard?.writeText(value!).then(
      () => toast.success(`${label} הועתק`),
      () => toast.error('העתקה נכשלה'),
    );
  }
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-slate-500">{label}:</span>
      <a href={href} className="font-medium text-slate-800 hover:text-brand-700 hover:underline tabular-nums">{value}</a>
      <button
        type="button" onClick={copy}
        className="text-slate-400 transition hover:text-brand-600"
        aria-label={`העתקת ${label}`}
        title={`העתקת ${label}`}
      >
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7">
          <rect x="6" y="6" width="10" height="10" rx="1.5" /><path d="M4 13V5a1 1 0 0 1 1-1h8" />
        </svg>
      </button>
    </div>
  );
}

const dayFormatter = new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });

function Transcript({ messages }: { messages: MessageRow[] }) {
  const grouped = useMemo(() => groupByDay(messages), [messages]);
  if (messages.length === 0) return <p className="mt-2 text-sm text-slate-500">אין הודעות.</p>;
  return (
    <ol className="mt-3 max-h-[60vh] space-y-3 overflow-auto pr-1 sm:max-h-[28rem]">
      {grouped.map(({ day, items }) => (
        <li key={day}>
          <div className="my-1 flex items-center gap-3">
            <span className="h-px flex-1 bg-slate-200" />
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">{day}</span>
            <span className="h-px flex-1 bg-slate-200" />
          </div>
          <ul className="space-y-2">
            {items.map((m) => (
              <li key={m.id} className={messageBubbleClass(m)}>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="font-medium text-slate-700">{senderLabel(m.sender_type)}</span>
                  <span>·</span>
                  <span title={m.created_at}>{formatRelative(m.created_at)}</span>
                  {m.provider_status ? <span className="kf-badge kf-badge-mute">{m.provider_status}</span> : null}
                </div>
                <div className="mt-1 whitespace-pre-wrap text-sm">
                  {m.content_text || (m.message_type === 'media' ? '[מדיה]' : '—')}
                </div>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function groupByDay(messages: MessageRow[]): Array<{ day: string; items: MessageRow[] }> {
  const groups = new Map<string, MessageRow[]>();
  for (const m of messages) {
    const ts = Date.parse(m.created_at);
    const key = Number.isFinite(ts) ? dayFormatter.format(new Date(ts)) : '—';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }
  return Array.from(groups.entries()).map(([day, items]) => ({ day, items }));
}

function senderLabel(t: MessageRow['sender_type']): string {
  switch (t) {
    case 'lead': return 'ליד';
    case 'ai': return 'AI';
    case 'mia': return 'מיה';
    case 'sales_rep': return 'איש מכירות';
    case 'system': return 'מערכת';
    case 'admin': return 'אדמין';
    default: return t;
  }
}

function messageBubbleClass(m: MessageRow): string {
  const base = 'rounded-2xl p-3 max-w-[85%] shadow-sm';
  if (m.direction === 'inbound') return `${base} bg-slate-100 mr-auto`;
  if (m.sender_type === 'ai') return `${base} bg-brand-50 ms-auto`;
  return `${base} bg-amber-50 ms-auto`;
}

function waLink(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '').replace(/^\+/, '');
  return `https://wa.me/${digits}`;
}

function CallLogForm({ onSubmit, submitting, errorMessage }: {
  onSubmit: (outcome: CallOutcome, durationMinutes: number, note: string | null) => void;
  submitting: boolean;
  errorMessage: string | null;
}) {
  const [outcome, setOutcome] = useState<CallOutcome>('connected');
  const [duration, setDuration] = useState<string>('5');
  const [note, setNote] = useState('');

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const minutes = Math.max(0, Number(duration) || 0);
    onSubmit(outcome, minutes, note.trim() || null);
    setNote('');
    setDuration('5');
  }

  return (
    <form onSubmit={submit} className="mt-2 space-y-2 text-sm">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="text-slate-600">תוצאה</span>
          <select className="kf-input mt-1" value={outcome} onChange={(e) => setOutcome(e.target.value as CallOutcome)}>
            <option value="connected">התקיימה שיחה</option>
            <option value="no_answer">אין מענה</option>
            <option value="voicemail">תא קולי</option>
            <option value="declined">סירב לדבר</option>
            <option value="callback_requested">ביקש שנחזור</option>
          </select>
        </label>
        <label className="block">
          <span className="text-slate-600">משך (דק׳)</span>
          <input type="number" min={0} max={180} className="kf-input mt-1" value={duration} onChange={(e) => setDuration(e.target.value)} />
        </label>
      </div>
      <textarea
        className="kf-input min-h-[64px]"
        placeholder="סיכום השיחה והצעדים הבאים..."
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button type="submit" className="kf-btn kf-btn-primary w-full sm:w-auto" disabled={submitting}>
        {submitting ? 'שומר...' : 'שמירת שיחה'}
      </button>
      {errorMessage ? <p className="text-rose-600">{errorMessage}</p> : null}
    </form>
  );
}

function ReplyBox({ disabled, onSend, sending, errorMessage }: {
  disabled: boolean;
  onSend: (text: string) => void;
  sending: boolean;
  errorMessage: string | null;
}) {
  const [text, setText] = useState('');

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!text.trim() || disabled) return;
    onSend(text.trim());
    setText('');
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-2">
      <textarea
        className="kf-input min-h-[88px]"
        placeholder={disabled ? 'לא ניתן לשלוח (ליד מושתק או חסרה שיחה).' : 'הקלד תשובה ידנית...'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
      />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <p className="text-xs text-slate-500">
          ייצא דרך WhatsApp באופן אוטומטי. מחוץ לחלון 24 שעות תישלח תבנית.
        </p>
        <button type="submit" className="kf-btn kf-btn-primary w-full sm:w-auto" disabled={disabled || sending || !text.trim()}>
          {sending ? 'שולח...' : 'שליחה'}
        </button>
      </div>
      {errorMessage ? <p className="text-sm text-rose-600">{errorMessage}</p> : null}
    </form>
  );
}
