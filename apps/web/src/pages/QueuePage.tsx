import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchQueueList, postQueueResolve } from '@/lib/api';
import { QUEUE_LABELS, formatRelative } from '@/lib/format';
import { HeatBadge, OwnershipBadge } from '@/components/Badge';
import { useToast } from '@/components/Toast';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

const QUEUE_TYPES = [
  '', 'first_response_due', 'hot_lead', 'sla_risk', 'human_handoff',
  'payment_pending', 'phone_escalation', 'nurture_due', 'dormant_review',
  'failed_automation', 'weekend_carryover', 'low_fit_cleanup',
];

type QueueStatus = 'pending' | 'claimed' | 'resolved';

export function QueuePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [type, setType] = useState(searchParams.get('type') ?? '');
  const [status, setStatus] = useState<QueueStatus>(
    (searchParams.get('status') as QueueStatus) || 'pending',
  );
  const qc = useQueryClient();
  const toast = useToast();
  useDocumentTitle('תורי עבודה');

  useEffect(() => {
    const next = new URLSearchParams();
    if (type) next.set('type', type);
    if (status !== 'pending') next.set('status', status);
    setSearchParams(next, { replace: true });
  }, [type, status, setSearchParams]);

  const q = useQuery({
    queryKey: ['queue', { type, status }],
    queryFn: () => fetchQueueList({ queueType: type || undefined, status }),
  });

  const resolve = useMutation({
    mutationFn: (queueItemId: string) => postQueueResolve({ queueItemId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue'] });
      toast.success('פריט נסגר');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const total = q.data?.length ?? 0;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">תורי עבודה</h1>
        <span className="text-sm text-slate-500">{total} פריטים</span>
      </header>

      <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <StatusTab active={status === 'pending'} onClick={() => setStatus('pending')}>פתוחים</StatusTab>
        <StatusTab active={status === 'claimed'} onClick={() => setStatus('claimed')}>בטיפול</StatusTab>
        <StatusTab active={status === 'resolved'} onClick={() => setStatus('resolved')}>סגורים</StatusTab>
      </div>

      <div className="kf-card p-4">
        <select className="kf-input w-full md:w-72" value={type} onChange={(e) => setType(e.target.value)}>
          {QUEUE_TYPES.map((t) => (
            <option key={t} value={t}>{t === '' ? 'כל הסוגים' : (QUEUE_LABELS[t] ?? t)}</option>
          ))}
        </select>
      </div>

      <div className="kf-card overflow-hidden md:overflow-visible">
        <table className="kf-table kf-table-responsive">
          <thead>
            <tr>
              <th>סוג</th>
              <th>ליד</th>
              <th>חום</th>
              <th>בעלות</th>
              <th>עדיפות</th>
              <th>סיבה</th>
              <th>נוצר</th>
              <th>פעולות</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              <tr><td colSpan={8} className="p-6 text-center text-slate-500">טוען...</td></tr>
            ) : q.data && q.data.length > 0 ? (
              q.data.map((row) => (
                <tr key={row.id}>
                  <td data-primary><strong>{QUEUE_LABELS[row.queue_type] ?? row.queue_type}</strong></td>
                  <td data-label="ליד">
                    <span className="block">
                      <Link to={`/leads/${row.lead_id}`} className="font-medium text-brand-700 hover:underline">
                        {row.leads?.full_name ?? row.lead_id.slice(0, 8)}
                      </Link>
                      <span className="block text-xs text-slate-500 tabular-nums">
                        {row.leads?.phone ? (
                          <a href={`tel:${row.leads.phone}`} className="hover:text-brand-700">{row.leads.phone}</a>
                        ) : '—'}
                      </span>
                    </span>
                  </td>
                  <td data-label="חום"><HeatBadge heat={row.leads?.lead_heat ?? null} /></td>
                  <td data-label="בעלות"><OwnershipBadge ownership={row.leads?.ownership_mode ?? null} /></td>
                  <td data-label="עדיפות"><PriorityPill priority={row.priority_level} /></td>
                  <td data-label="סיבה" className="md:max-w-xs md:truncate" title={row.reason ?? ''}>{row.reason || '—'}</td>
                  <td data-label="נוצר" className="text-slate-500" title={row.created_at}>{formatRelative(row.created_at)}</td>
                  <td data-actions>
                    {status === 'pending' || status === 'claimed' ? (
                      <button
                        type="button" className="kf-btn text-xs"
                        onClick={() => resolve.mutate(row.id)}
                        disabled={resolve.isPending}
                      >סגירה</button>
                    ) : (
                      <span className="text-xs text-slate-500">{row.resolution_note || 'נסגר'}</span>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8} className="p-12 text-center">
                  <div className="flex flex-col items-center gap-2 text-slate-500">
                    <svg viewBox="0 0 24 24" className="h-10 w-10 text-emerald-300" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12.5 9.5 17 19 7" />
                    </svg>
                    <span className="font-medium text-slate-600">אין פריטים{type ? ` בקטגוריה ${QUEUE_LABELS[type] ?? type}` : ''}.</span>
                    <span className="text-xs">תור עבודה ריק זה רגע טוב לרוץ עם ליד חדש.</span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button" onClick={onClick}
      className={
        'rounded-full px-4 py-1.5 text-sm font-medium transition ' +
        (active ? 'bg-brand-600 text-white shadow-sm' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50')
      }
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function PriorityPill({ priority }: { priority: number }) {
  // work_queue.priority_level is constrained to 1-5; lower number = more urgent.
  const tone =
    priority <= 1 ? 'bg-rose-50 text-rose-700' :
    priority <= 2 ? 'bg-amber-50 text-amber-700' :
    'bg-slate-100 text-slate-600';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${tone}`}>
      {priority}
    </span>
  );
}
