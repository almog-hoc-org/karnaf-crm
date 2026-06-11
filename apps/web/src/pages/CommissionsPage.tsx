import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { fetchCommissions, postCommissionAction } from '@/lib/api';
import type { CommissionRow, CommissionStatus } from '@/lib/types';
import { useToast } from '@/components/Toast';
import { PageIntro } from '@/components/PageIntro';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { COMMISSION_STATUS_LABELS, formatRelative } from '@/lib/format';
import { t } from '@/lib/i18n';

// Tier 7.C.1 — labels live in lib/format.ts. Local alias keeps the
// rest of the file readable without rewriting every reference.
const STATUS_LABELS = COMMISSION_STATUS_LABELS as Record<CommissionStatus, string>;

const STATUS_TONE: Record<CommissionStatus, string> = {
  pending: 'bg-amber-50 text-amber-800 ring-amber-200',
  to_bill: 'bg-rose-50 text-rose-800 ring-rose-200',
  paid: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  cancelled: 'bg-slate-100 text-slate-600 ring-slate-200',
};

export function CommissionsPage() {
  useDocumentTitle('עמלות');
  const toast = useToast();
  const qc = useQueryClient();

  const [params, setParams] = useSearchParams();
  const statusFilter = (params.get('status') as CommissionStatus | null) ?? null;

  const q = useQuery({
    queryKey: ['commissions', statusFilter ?? 'all'],
    queryFn: () => fetchCommissions(statusFilter ?? undefined),
  });

  const action = useMutation({
    mutationFn: postCommissionAction,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['commissions'] });
      toast.success('עודכן');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const commissions = q.data?.commissions ?? [];

  // Summary by status — gives Mia the headline numbers above the table.
  // Read q.data inside the memo so the `?? []` fallback doesn't churn.
  const summary = useMemo(() => {
    const acc: Record<CommissionStatus, { count: number; amount: number }> = {
      pending: { count: 0, amount: 0 },
      to_bill: { count: 0, amount: 0 },
      paid: { count: 0, amount: 0 },
      cancelled: { count: 0, amount: 0 },
    };
    for (const c of q.data?.commissions ?? []) {
      acc[c.status].count++;
      acc[c.status].amount += c.amount_received ?? c.amount_due;
    }
    return acc;
  }, [q.data?.commissions]);

  const [paying, setPaying] = useState<CommissionRow | null>(null);
  const [cancelling, setCancelling] = useState<CommissionRow | null>(null);

  function setStatus(s: CommissionStatus | null) {
    const next = new URLSearchParams(params);
    if (s) next.set('status', s); else next.delete('status');
    setParams(next, { replace: true });
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">עמלות</h1>
      </header>
      <PageIntro>
        עמלות נוצרות אוטומטית כשמתעדים תשלום דמי רצינות על העסקה. כשחותמים חוזה
        → ״לחיוב״. ידני: סימון התשלום שהתקבל בפועל.
      </PageIntro>

      {/* Summary chips */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(['pending', 'to_bill', 'paid', 'cancelled'] as CommissionStatus[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(statusFilter === s ? null : s)}
            className={clsx(
              'kf-card flex flex-col gap-1 p-3 text-left transition',
              statusFilter === s && 'ring-2 ring-brand-500',
            )}
          >
            <span className="text-xs text-slate-500">{STATUS_LABELS[s]}</span>
            <span className="text-2xl font-semibold tabular-nums">{summary[s].count}</span>
            <span className="text-xs text-slate-500 tabular-nums">
              {summary[s].amount.toLocaleString('he-IL')} ₪
            </span>
          </button>
        ))}
      </div>

      <div className="kf-card overflow-hidden md:overflow-visible">
        <table className="kf-table kf-table-responsive">
          <thead>
            <tr>
              <th>סטטוס</th>
              <th>שותף</th>
              <th>עסקה</th>
              <th>%</th>
              <th>סכום</th>
              <th>תאריך לחיוב</th>
              <th>פעולות</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              <tr><td colSpan={7} className="p-6 text-center text-slate-500">{t('loading')}</td></tr>
            ) : commissions.length > 0 ? (
              commissions.map((c) => (
                <tr key={c.id}>
                  <td data-primary>
                    <span className={clsx(
                      'rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
                      STATUS_TONE[c.status],
                    )}>{STATUS_LABELS[c.status]}</span>
                  </td>
                  <td data-label="שותף">{c.partners?.full_name ?? '—'}</td>
                  <td data-label="עסקה">
                    {c.deal_id ? (
                      <Link to={`/leads`} className="text-brand-700 hover:underline" title={c.deal_id}>
                        {c.deal_id.slice(0, 8)}
                      </Link>
                    ) : '—'}
                    {c.deals?.value ? (
                      <div className="text-xs text-slate-500 tabular-nums">
                        {c.deals.value.toLocaleString('he-IL')} {c.currency}
                      </div>
                    ) : null}
                  </td>
                  <td data-label="%" className="tabular-nums">{c.pct_snapshot}%</td>
                  <td data-label="סכום" className="tabular-nums font-medium">
                    {(c.amount_received ?? c.amount_due).toLocaleString('he-IL')} {c.currency}
                  </td>
                  <td data-label="לחיוב" className="text-xs text-slate-500" title={c.to_bill_at ?? ''}>
                    {c.to_bill_at ? formatRelative(c.to_bill_at) : '—'}
                  </td>
                  <td data-actions>
                    <div className="flex flex-wrap gap-1">
                      {c.status === 'to_bill' ? (
                        <button type="button" className="kf-btn kf-btn-primary text-xs"
                          onClick={() => setPaying(c)}>סמן שולם</button>
                      ) : null}
                      {(c.status === 'pending' || c.status === 'to_bill') ? (
                        <button type="button" className="kf-btn text-xs"
                          onClick={() => setCancelling(c)}>ביטול</button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr><td colSpan={7} className="p-6 text-center text-slate-500">אין עמלות בתצוגה זו.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {paying ? (
        <PaymentDialog
          commission={paying}
          busy={action.isPending}
          onSubmit={(payload) => {
            action.mutate({ action: 'mark_paid', id: paying.id, ...payload });
            setPaying(null);
          }}
          onCancel={() => setPaying(null)}
        />
      ) : null}

      {cancelling ? (
        <CancellationDialog
          busy={action.isPending}
          onSubmit={(reason) => {
            action.mutate({ action: 'cancel', id: cancelling.id, cancellation_reason: reason });
            setCancelling(null);
          }}
          onCancel={() => setCancelling(null)}
        />
      ) : null}
    </div>
  );
}

function PaymentDialog({
  commission,
  busy,
  onSubmit,
  onCancel,
}: {
  commission: CommissionRow;
  busy: boolean;
  onSubmit: (payload: { amount_received: number; payment_method?: string; payment_reference?: string; notes?: string }) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(String(commission.amount_due));
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSubmit({
      amount_received: Number(amount),
      payment_method: method,
      payment_reference: reference.trim() || undefined,
      notes: notes.trim() || undefined,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <form className="kf-card w-full max-w-md space-y-3 p-5" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">סימון עמלה כשולמה</h2>
        <p className="text-xs text-slate-500">
          חיוב צפוי: {commission.amount_due.toLocaleString('he-IL')} {commission.currency}
        </p>
        <label className="block text-sm">
          <span className="text-slate-600">סכום שהתקבל</span>
          <input className="kf-input mt-1 tabular-nums" type="number" min={0} step="0.01" required
            value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="text-slate-600">אמצעי תשלום</span>
          <select className="kf-input mt-1" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="bank_transfer">העברה בנקאית</option>
            <option value="cash">מזומן</option>
            <option value="check">המחאה</option>
            <option value="credit_card">אשראי</option>
            <option value="other">אחר</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-slate-600">אסמכתא (חשבונית / מזהה העברה)</span>
          <input className="kf-input mt-1" value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="text-slate-600">הערות</span>
          <textarea className="kf-input mt-1 min-h-[60px]" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="kf-btn" onClick={onCancel}>ביטול</button>
          <button type="submit" className="kf-btn kf-btn-primary" disabled={busy}>{busy ? 'שומר...' : 'שמירה'}</button>
        </div>
      </form>
    </div>
  );
}

function CancellationDialog({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!reason.trim()) return;
    onSubmit(reason.trim());
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <form className="kf-card w-full max-w-md space-y-3 p-5" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">ביטול עמלה</h2>
        <p className="text-xs text-slate-500">פעולה לא הפיכה — הקפד לתעד את הסיבה.</p>
        <label className="block text-sm">
          <span className="text-slate-600">סיבה</span>
          <textarea className="kf-input mt-1 min-h-[80px]" required
            value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="kf-btn" onClick={onCancel}>ביטול</button>
          <button type="submit" className="kf-btn kf-btn-danger" disabled={busy}>{busy ? 'מבטל...' : 'בטל עמלה'}</button>
        </div>
      </form>
    </div>
  );
}
