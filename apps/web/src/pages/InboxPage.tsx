import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { fetchAttentionInbox, postQueueResolve } from '@/lib/api';
import { HeatBadge, OwnershipBadge, StatusBadge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { formatRelative, QUEUE_LABELS } from '@/lib/format';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import type { AttentionRow } from '@/lib/types';

type WorkLane = 'all' | 'reply' | 'call' | 'risk' | 'ops';

const LANE_FILTERS: Array<{ key: WorkLane; label: string; hint: string }> = [
  { key: 'all', label: 'הכל', hint: 'כל מה שדורש טיפול' },
  { key: 'reply', label: 'לענות עכשיו', hint: 'לקוחות שממתינים למענה אנושי' },
  { key: 'call', label: 'להתקשר', hint: 'בקשות שיחה ולידים חמים' },
  { key: 'risk', label: 'בסיכון', hint: 'SLA, איחורים ותקלות' },
  { key: 'ops', label: 'תפעול', hint: 'בדיקה, תשלום, מעקב וסגירות' },
];

export function InboxPage() {
  useDocumentTitle('לטיפול עכשיו');
  const [lane, setLane] = useState<WorkLane>('all');
  const [pendingClose, setPendingClose] = useState<AttentionRow | null>(null);
  const [closeNote, setCloseNote] = useState('');
  const qc = useQueryClient();
  const toast = useToast();

  const q = useQuery({
    queryKey: ['attention-inbox'],
    queryFn: () => fetchAttentionInbox(),
    refetchInterval: 30_000,
  });

  const allRows = useMemo(() => sortRows(q.data ?? []), [q.data]);
  const rows = useMemo(() => (
    lane === 'all' ? allRows : allRows.filter((row) => classifyRow(row).lane === lane)
  ), [allRows, lane]);

  const counts = useMemo(() => {
    const acc: Record<WorkLane, number> = { all: allRows.length, reply: 0, call: 0, risk: 0, ops: 0 };
    for (const row of allRows) acc[classifyRow(row).lane] += 1;
    return acc;
  }, [allRows]);

  const resolve = useMutation({
    mutationFn: (input: { queueItemId: string; note?: string | null }) =>
      postQueueResolve({ queueItemId: input.queueItemId, resolutionNote: input.note ?? null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['attention-inbox'] });
      qc.invalidateQueries({ queryKey: ['queue'] });
      toast.success('המשימה נסגרה');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const urgent = allRows.filter((row) => classifyRow(row).urgency === 'critical').length;

  return (
    <div className="space-y-5">
      <header className="overflow-hidden rounded-3xl bg-gradient-to-l from-brand-700 via-brand-600 to-slate-900 p-5 text-white shadow-sm sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <p className="text-sm font-medium text-brand-100">עמדת מנהלת CRM</p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">לטיפול עכשיו</h1>
            <p className="max-w-2xl text-sm leading-6 text-brand-50/90">
              מקום אחד לכל מה שמצריך פעולה: לקוחות שמחכים לתשובה, שיחות, תקלות, איחורים ומעקבים.
              בלי להבדיל בין Inbox, Queue או סטטוס טכני.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:min-w-[360px]">
            <Metric label="פתוח" value={allRows.length} />
            <Metric label="דחוף" value={urgent} tone={urgent > 0 ? 'danger' : 'ok'} />
            <Metric label="רענון" value="30ש׳" />
          </div>
        </div>
      </header>

      <section className="grid gap-3 md:grid-cols-5" aria-label="סינון משימות">
        {LANE_FILTERS.map((item) => {
          const active = lane === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setLane(item.key)}
              aria-pressed={active}
              className={clsx(
                'rounded-2xl border p-4 text-start shadow-sm transition',
                active
                  ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-100'
                  : 'border-slate-200 bg-white hover:border-brand-200 hover:bg-slate-50',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={clsx('font-semibold', active ? 'text-brand-800' : 'text-slate-800')}>{item.label}</span>
                <span className={clsx(
                  'rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums',
                  active ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600',
                )}>{counts[item.key]}</span>
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500">{item.hint}</p>
            </button>
          );
        })}
      </section>

      <section className="space-y-3">
        {q.isLoading ? (
          <div className="kf-card p-10 text-center text-slate-500">טוען משימות...</div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="🎉"
            title="אין כרגע טיפול פתוח בקטגוריה הזו"
            hint="המסך מתרענן אוטומטית. אם נכנס ליד או שהלקוח ענה — הוא יופיע כאן."
          />
        ) : (
          rows.map((row) => {
            const meta = classifyRow(row);
            return (
              <article
                key={`${row.kind}:${row.ref_id}`}
                className={clsx(
                  'kf-card overflow-hidden border-s-4 p-4 transition hover:shadow-md sm:p-5',
                  meta.borderClass,
                )}
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={clsx('rounded-full px-2.5 py-1 text-xs font-semibold', meta.pillClass)}>{meta.actionLabel}</span>
                      <span className="text-xs text-slate-500">{formatRelative(row.due_at ?? row.created_at)}</span>
                      {meta.urgency === 'critical' ? (
                        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">דחוף</span>
                      ) : null}
                    </div>

                    <div>
                      <Link to={`/leads/${row.lead_id}`} className="text-lg font-semibold text-slate-900 hover:text-brand-700 hover:underline">
                        {row.lead_name || `ליד ${row.lead_id.slice(0, 8)}`}
                      </Link>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
                        {row.lead_phone ? <a href={`tel:${row.lead_phone}`} className="tabular-nums hover:text-brand-700">{row.lead_phone}</a> : null}
                        <span>{humanReason(row)}</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={row.lead_status} />
                      <HeatBadge heat={row.lead_heat} />
                      <OwnershipBadge ownership={row.ownership_mode} />
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">עדיפות {row.priority_level}</span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 sm:min-w-[220px] sm:flex-row lg:flex-col">
                    <Link to={`/leads/${row.lead_id}`} className="kf-btn justify-center">
                      פתיחת ליד
                    </Link>
                    {row.kind === 'queue' ? (
                      <button
                        type="button"
                        className="kf-btn kf-btn-ghost justify-center"
                        disabled={resolve.isPending}
                        onClick={() => {
                          setPendingClose(row);
                          setCloseNote('');
                        }}
                      >
                        סגירת משימה
                      </button>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })
        )}
      </section>

      <ConfirmDialog
        open={!!pendingClose}
        title="סגירת משימה"
        description={pendingClose ? humanReason(pendingClose) : 'ניתן להוסיף הערה קצרה לסגירה.'}
        confirmLabel="סגירה"
        busy={resolve.isPending}
        onCancel={() => setPendingClose(null)}
        onConfirm={() => {
          if (!pendingClose) return;
          const note = closeNote.trim();
          resolve.mutate({ queueItemId: pendingClose.ref_id, note: note.length ? note : null });
          setPendingClose(null);
        }}
      >
        <label className="block text-sm">
          <span className="text-slate-600">הערת סגירה</span>
          <textarea
            className="kf-input mt-1 min-h-[72px]"
            placeholder="לדוגמה: טופל בוואטסאפ, נקבעה שיחה, לא רלוונטי..."
            value={closeNote}
            onChange={(e) => setCloseNote(e.target.value.slice(0, 500))}
            maxLength={500}
          />
        </label>
      </ConfirmDialog>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number | string; tone?: 'danger' | 'ok' }) {
  return (
    <div className="rounded-2xl bg-white/12 p-3 ring-1 ring-white/20 backdrop-blur">
      <div className="text-xs text-white/75">{label}</div>
      <div className={clsx('mt-1 text-2xl font-semibold tabular-nums', tone === 'danger' && 'text-rose-100', tone === 'ok' && 'text-emerald-100')}>
        {value}
      </div>
    </div>
  );
}

function classifyRow(row: AttentionRow): {
  lane: WorkLane;
  actionLabel: string;
  urgency: 'critical' | 'normal';
  pillClass: string;
  borderClass: string;
} {
  const reason = `${row.reason ?? ''} ${row.lead_status} ${row.ownership_mode}`.toLowerCase();
  const dueMs = row.due_at ? Date.parse(row.due_at) : NaN;
  const overdue = row.kind === 'overdue_action' || (Number.isFinite(dueMs) && dueMs < Date.now());

  if (row.kind === 'mia_reply' || row.ownership_mode === 'mia_active' || row.lead_status === 'human_handoff') {
    return {
      lane: 'reply', actionLabel: 'לענות עכשיו', urgency: overdue ? 'critical' : 'normal',
      pillClass: 'bg-amber-100 text-amber-800', borderClass: 'border-s-amber-400',
    };
  }
  if (row.ownership_mode === 'phone_sales_pending' || reason.includes('phone') || reason.includes('שיחה') || reason.includes('טלפון')) {
    return {
      lane: 'call', actionLabel: 'להתקשר', urgency: row.priority_level <= 1 ? 'critical' : 'normal',
      pillClass: 'bg-indigo-100 text-indigo-800', borderClass: 'border-s-indigo-400',
    };
  }
  if (overdue || reason.includes('sla') || reason.includes('failed') || reason.includes('תקלה') || reason.includes('כשל')) {
    return {
      lane: 'risk', actionLabel: 'לטפל בסיכון', urgency: 'critical',
      pillClass: 'bg-rose-100 text-rose-800', borderClass: 'border-s-rose-500',
    };
  }
  return {
    lane: 'ops', actionLabel: 'בדיקה / מעקב', urgency: 'normal',
    pillClass: 'bg-sky-100 text-sky-800', borderClass: 'border-s-sky-400',
  };
}

function humanReason(row: AttentionRow): string {
  if (row.reason) return row.reason;
  if (row.kind === 'mia_reply') return 'הלקוח השיב ומחכה למענה אנושי';
  if (row.kind === 'overdue_action') return 'הפעולה הבאה באיחור';
  if (row.kind === 'queue') return QUEUE_LABELS[row.ref_id] ?? 'משימה פתוחה לטיפול';
  return 'דורש בדיקה';
}

function sortRows(rows: AttentionRow[]): AttentionRow[] {
  return [...rows].sort((a, b) => {
    const ac = classifyRow(a).urgency === 'critical' ? 0 : 1;
    const bc = classifyRow(b).urgency === 'critical' ? 0 : 1;
    if (ac !== bc) return ac - bc;
    if (a.priority_level !== b.priority_level) return a.priority_level - b.priority_level;
    return dateValue(a.due_at ?? a.created_at) - dateValue(b.due_at ?? b.created_at);
  });
}

function dateValue(value: string | null | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : Number.MAX_SAFE_INTEGER;
}
