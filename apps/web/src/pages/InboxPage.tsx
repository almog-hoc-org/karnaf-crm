import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { fetchAttentionInbox } from '@/lib/api';
import { HeatBadge, OwnershipBadge, StatusBadge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { formatRelative } from '@/lib/format';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import type { AttentionKind, AttentionRow } from '@/lib/types';

const KIND_LABEL: Record<AttentionKind, string> = {
  queue: 'תור',
  mia_reply: 'הלקוח השיב',
  overdue_action: 'פעולה באיחור',
};

const KIND_TONE: Record<AttentionKind, string> = {
  queue: 'bg-sky-50 text-sky-700 ring-sky-200',
  mia_reply: 'bg-amber-50 text-amber-800 ring-amber-200',
  overdue_action: 'bg-rose-50 text-rose-800 ring-rose-200',
};

const KIND_FILTERS: Array<{ key: AttentionKind | 'all'; label: string }> = [
  { key: 'all', label: 'הכל' },
  { key: 'mia_reply', label: 'תגובות פתוחות' },
  { key: 'overdue_action', label: 'פעולות באיחור' },
  { key: 'queue', label: 'פריטי תור' },
];

export function InboxPage() {
  useDocumentTitle('דורש תשומת לב');
  const [filter, setFilter] = useState<AttentionKind | 'all'>('all');

  const q = useQuery({
    queryKey: ['attention-inbox'],
    queryFn: () => fetchAttentionInbox(),
    refetchInterval: 30_000,
  });

  const rows = useMemo<AttentionRow[]>(() => {
    const all = q.data ?? [];
    return filter === 'all' ? all : all.filter((r) => r.kind === filter);
  }, [q.data, filter]);

  const counts = useMemo(() => {
    const acc: Record<AttentionKind, number> = { queue: 0, mia_reply: 0, overdue_action: 0 };
    for (const r of q.data ?? []) acc[r.kind] = (acc[r.kind] ?? 0) + 1;
    return acc;
  }, [q.data]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">דורש תשומת לב</h1>
        <p className="text-sm text-slate-500">
          איחוד של: תגובות שהלקוח השיב להן ולא נענו, פעולות שתאריך היעד עבר ופריטי תור פתוחים.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {KIND_FILTERS.map(({ key, label }) => {
          const count = key === 'all' ? (q.data ?? []).length : counts[key];
          const active = filter === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              aria-pressed={active}
              className={clsx(
                'rounded-full px-3 py-1.5 text-sm font-medium transition',
                active ? 'bg-brand-600 text-white shadow-sm' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50',
              )}
            >
              {label} <span className="ms-1 tabular-nums opacity-80">({count})</span>
            </button>
          );
        })}
      </div>

      <div className="kf-card overflow-hidden">
        {q.isLoading ? (
          <div className="p-10 text-center text-slate-500">טוען...</div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="🎉"
            title="הכל סגור — אין מה לטפל כרגע"
            hint="התצוגה מתרעננת אוטומטית כל 30 שניות."
          />
        ) : (
          <table className="kf-table">
            <thead>
              <tr>
                <th>סוג</th>
                <th>ליד</th>
                <th>סטטוס</th>
                <th>חום</th>
                <th>בעלות</th>
                <th>סיבה</th>
                <th>מתי</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const dueMs = row.due_at ? Date.parse(row.due_at) : NaN;
                const overdue = Number.isFinite(dueMs) && dueMs < Date.now() && row.kind !== 'overdue_action';
                return (
                  <tr key={`${row.kind}:${row.ref_id}`} className={row.kind === 'overdue_action' || overdue ? 'bg-rose-50/40' : undefined}>
                    <td>
                      <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', KIND_TONE[row.kind])}>
                        {KIND_LABEL[row.kind]}
                      </span>
                    </td>
                    <td>
                      <Link to={`/leads/${row.lead_id}`} className="font-medium text-brand-700 hover:underline">
                        {row.lead_name || row.lead_id.slice(0, 8)}
                      </Link>
                      {row.lead_phone ? (
                        <div className="text-xs text-slate-500 tabular-nums">{row.lead_phone}</div>
                      ) : null}
                    </td>
                    <td><StatusBadge status={row.lead_status} /></td>
                    <td><HeatBadge heat={row.lead_heat} /></td>
                    <td><OwnershipBadge ownership={row.ownership_mode} /></td>
                    <td className="max-w-xs truncate text-sm text-slate-700" title={row.reason ?? ''}>{row.reason ?? '—'}</td>
                    <td className="text-sm text-slate-500" title={row.due_at ?? row.created_at ?? ''}>
                      {formatRelative(row.due_at ?? row.created_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
