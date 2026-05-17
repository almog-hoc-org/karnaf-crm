import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchQueueList, postQueueResolve } from '@/lib/api';
import { QUEUE_LABELS, formatRelative } from '@/lib/format';
import { HeatBadge, OwnershipBadge } from '@/components/Badge';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { t } from '@/lib/i18n';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

import { computeSlaState, slaRowClass } from '@/lib/queue-sla';

const QUEUE_TYPES = [
  '', 'first_response_due', 'hot_lead', 'sla_risk', 'ai_stuck', 'human_handoff',
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
  useDocumentTitle(t('queue_title'));

  useEffect(() => {
    const next = new URLSearchParams();
    if (type) next.set('type', type);
    if (status !== 'pending') next.set('status', status);
    setSearchParams(next, { replace: true });
  }, [type, status, setSearchParams]);

  const q = useQuery({
    queryKey: ['queue', { type, status }],
    queryFn: () => fetchQueueList({ queueType: type || undefined, status }),
    // Mia parks her day on /queue — without polling she'd miss new
    // queue items emitted by sla-worker (10min tick). 30s catches
    // those within roughly the same TTL as the bell on her phone.
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  const resolve = useMutation({
    mutationFn: (input: { queueItemId: string; note?: string | null }) =>
      postQueueResolve({ queueItemId: input.queueItemId, resolutionNote: input.note ?? null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue'] });
      toast.success(t('queue_item_closed'));
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const [pendingClose, setPendingClose] = useState<{ id: string; label: string } | null>(null);
  const [closeNote, setCloseNote] = useState('');

  const total = q.data?.length ?? 0;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{t('queue_title')}</h1>
        <span className="text-sm text-slate-500">{total} {t('queue_total_items')}</span>
      </header>

      <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <StatusTab active={status === 'pending'} onClick={() => setStatus('pending')}>{t('queue_open')}</StatusTab>
        <StatusTab active={status === 'claimed'} onClick={() => setStatus('claimed')}>{t('queue_claimed')}</StatusTab>
        <StatusTab active={status === 'resolved'} onClick={() => setStatus('resolved')}>{t('queue_resolved')}</StatusTab>
      </div>

      <div className="kf-card p-4">
        <select className="kf-input w-full md:w-72" value={type} onChange={(e) => setType(e.target.value)}>
          {QUEUE_TYPES.map((queueType) => (
            <option key={queueType} value={queueType}>{queueType === '' ? t('queue_all_types') : (QUEUE_LABELS[queueType] ?? queueType)}</option>
          ))}
        </select>
      </div>

      <div className="kf-card overflow-hidden md:overflow-visible">
        <table className="kf-table kf-table-responsive">
          <thead>
            <tr>
              <th>{t('queue_type')}</th>
              <th>{t('queue_lead')}</th>
              <th>{t('queue_heat')}</th>
              <th>{t('queue_ownership')}</th>
              <th>{t('queue_priority')}</th>
              <th>{t('queue_reason')}</th>
              <th>{t('queue_created')}</th>
              <th>{t('queue_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              <tr><td colSpan={8} className="p-6 text-center text-slate-500">{t('loading')}</td></tr>
            ) : q.data && q.data.length > 0 ? (
              q.data.map((row) => {
                const sla = computeSlaState(row.queue_type, row.created_at);
                const slaTitle = sla.targetMinutes !== null
                  ? `SLA יעד ${sla.targetMinutes} דק׳ · גיל ${sla.ageMinutes ?? '?'} דק׳`
                  : '';
                return (
                <tr key={row.id} className={slaRowClass(sla.state)} title={slaTitle}>
                  <td data-primary>
                    <strong>{QUEUE_LABELS[row.queue_type] ?? row.queue_type}</strong>
                    {sla.state === 'overdue' ? (
                      <span className="ms-2 inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700">SLA</span>
                    ) : sla.state === 'warning' ? (
                      <span className="ms-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">בקרוב SLA</span>
                    ) : null}
                  </td>
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
                        onClick={() => {
                          setPendingClose({ id: row.id, label: QUEUE_LABELS[row.queue_type] ?? row.queue_type });
                          setCloseNote('');
                        }}
                        disabled={resolve.isPending}
                      >{t('queue_close')}</button>
                    ) : (
                      <span className="text-xs text-slate-500">{row.resolution_note || t('queue_closed')}</span>
                    )}
                  </td>
                </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={8} className="p-12 text-center">
                  <div className="flex flex-col items-center gap-2 text-slate-500">
                    <svg viewBox="0 0 24 24" className="h-10 w-10 text-emerald-300" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12.5 9.5 17 19 7" />
                    </svg>
                    <span className="font-medium text-slate-600">{t('queue_empty')}{type ? ` בקטגוריה ${QUEUE_LABELS[type] ?? type}` : ''}{t('queue_empty_suffix')}</span>
                    <span className="text-xs">{t('queue_empty_hint')}</span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={!!pendingClose}
        title={`סגירת פריט תור — ${pendingClose?.label ?? ''}`}
        description="ניתן להוסיף סיבת סגירה לצרכי תיעוד (אופציונלי)."
        confirmLabel={t('queue_close')}
        busy={resolve.isPending}
        onCancel={() => setPendingClose(null)}
        onConfirm={() => {
          if (!pendingClose) return;
          const note = closeNote.trim();
          resolve.mutate({ queueItemId: pendingClose.id, note: note.length ? note : null });
          setPendingClose(null);
        }}
      >
        <label className="block text-sm">
          <span className="text-slate-600">סיבת סגירה</span>
          <textarea
            className="kf-input mt-1 min-h-[64px]"
            placeholder="לדוגמה: ליד חזר ונענה, פוטר אוטומטית..."
            value={closeNote}
            onChange={(e) => setCloseNote(e.target.value.slice(0, 500))}
            maxLength={500}
          />
        </label>
      </ConfirmDialog>
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
  const severityLabel = priority <= 1 ? t('priority') + ' גבוהה' : priority <= 2 ? t('priority') + ' בינונית' : t('priority') + ' נמוכה';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${tone}`}
      aria-label={`${severityLabel} (${priority})`}
    >
      {priority}
    </span>
  );
}
