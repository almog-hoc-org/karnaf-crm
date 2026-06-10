import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchPartners, postPartnerAction } from '@/lib/api';
import type { PartnerDomain, PartnerRow, PartnerStatus, PartnerWorkloadRow } from '@/lib/types';
import { useToast } from '@/components/Toast';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { t } from '@/lib/i18n';

const DOMAIN_LABELS: Record<PartnerDomain, string> = {
  investor_mentorship: 'ליווי משקיעים',
  appraisal: 'שמאות',
  legal: 'משפטי',
  financing: 'מימון',
  other: 'אחר',
};

const STATUS_LABELS: Record<PartnerStatus, string> = {
  active: 'פעיל',
  paused: 'מושהה',
  archived: 'בארכיון',
};

export function PartnersPage() {
  useDocumentTitle('פרילנסרים ושותפים');
  const toast = useToast();
  const qc = useQueryClient();

  const partnersQ = useQuery({ queryKey: ['partners'], queryFn: fetchPartners });

  const action = useMutation({
    mutationFn: postPartnerAction,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['partners'] });
      toast.success('עודכן');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const partners = partnersQ.data?.partners ?? [];
  // Index workload by partner_id so each row lookup is O(1). Read
  // partnersQ.data directly inside the memo so the `?? []` fallback's
  // identity doesn't churn on every render.
  const workloadById = useMemo(() => {
    const m = new Map<string, PartnerWorkloadRow>();
    for (const w of partnersQ.data?.workload ?? []) m.set(w.partner_id, w);
    return m;
  }, [partnersQ.data?.workload]);

  const [editing, setEditing] = useState<PartnerRow | null>(null);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">פרילנסרים ושותפים</h1>
        <span className="text-sm text-slate-500">{partners.length} שותפים</span>
      </header>

      <p className="text-sm text-slate-500">
        שותפים חיצוניים שסוגרים בשם קרנף. אחוז העמלה נחתך מערך כל עסקה שמועברת
        לשותף וניתן לשינוי בכל עת — שינוי אינו משכתב עמלות שכבר נוצרו (הן נשמרות
        עם ה-% שהיה בתוקף ביום יצירתן).
      </p>

      <CreateForm onSubmit={(payload) => action.mutate(payload)} busy={action.isPending} />

      <div className="kf-card overflow-hidden md:overflow-visible">
        <table className="kf-table kf-table-responsive">
          <thead>
            <tr>
              <th>שם</th>
              <th>תחום</th>
              <th>טלפון</th>
              <th>% לקרנף</th>
              <th>עסקאות פתוחות</th>
              <th>נסגרו</th>
              <th>סטטוס</th>
              <th>פעולות</th>
            </tr>
          </thead>
          <tbody>
            {partnersQ.isLoading ? (
              <tr><td colSpan={8} className="p-6 text-center text-slate-500">{t('loading')}</td></tr>
            ) : partners.length > 0 ? (
              partners.map((p) => {
                const w = workloadById.get(p.id);
                return (
                  <tr key={p.id} className={p.status === 'active' ? undefined : 'opacity-60'}>
                    <td data-primary><strong>{p.full_name}</strong></td>
                    <td data-label="תחום">{DOMAIN_LABELS[p.domain] ?? p.domain}</td>
                    <td data-label="טלפון" className="tabular-nums text-slate-500">{p.phone || '—'}</td>
                    <td data-label="% לקרנף" className="tabular-nums">{p.commission_to_karnaf_pct}%</td>
                    <td data-label="פתוחות" className="tabular-nums">{w?.open_deals_count ?? 0}</td>
                    <td data-label="נסגרו" className="tabular-nums">{w?.won_deals_count ?? 0}</td>
                    <td data-label="סטטוס">{STATUS_LABELS[p.status] ?? p.status}</td>
                    <td data-actions>
                      <div className="flex flex-wrap gap-1">
                        <button type="button" className="kf-btn text-xs" onClick={() => setEditing(p)}>עריכה</button>
                        {p.status !== 'active' ? (
                          <button type="button" className="kf-btn text-xs" disabled={action.isPending}
                            onClick={() => action.mutate({ action: 'restore', id: p.id })}>החזרה</button>
                        ) : (
                          <button type="button" className="kf-btn text-xs" disabled={action.isPending}
                            onClick={() => action.mutate({ action: 'pause', id: p.id })}>השהיה</button>
                        )}
                        {p.status !== 'archived' ? (
                          <button type="button" className="kf-btn text-xs" disabled={action.isPending}
                            onClick={() => action.mutate({ action: 'archive', id: p.id })}>ארכיון</button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr><td colSpan={8} className="p-6 text-center text-slate-500">אין שותפים. צור שותף ראשון למעלה.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editing ? (
        <EditDialog
          partner={editing}
          busy={action.isPending}
          onSubmit={(patch) => {
            action.mutate({ action: 'update', id: editing.id, ...patch });
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function CreateForm({
  onSubmit,
  busy,
}: {
  onSubmit: (payload: { action: 'create'; full_name: string; phone?: string; email?: string;
    domain: PartnerDomain; commission_to_karnaf_pct?: number; notes?: string }) => void;
  busy: boolean;
}) {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [domain, setDomain] = useState<PartnerDomain>('investor_mentorship');
  const [pct, setPct] = useState('30');

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!fullName.trim()) return;
    onSubmit({
      action: 'create',
      full_name: fullName.trim(),
      phone: phone.trim() || undefined,
      domain,
      commission_to_karnaf_pct: Number(pct) || 0,
    });
    setFullName(''); setPhone(''); setPct('30');
  }

  return (
    <form onSubmit={submit} className="kf-card grid grid-cols-1 gap-3 p-4 sm:grid-cols-5">
      <input className="kf-input sm:col-span-2" placeholder="שם מלא" required
        value={fullName} onChange={(e) => setFullName(e.target.value)} />
      <input className="kf-input" placeholder="טלפון (אופציונלי)"
        value={phone} onChange={(e) => setPhone(e.target.value)} />
      <select className="kf-input" value={domain} onChange={(e) => setDomain(e.target.value as PartnerDomain)}>
        {Object.entries(DOMAIN_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <div className="flex gap-2">
        <input className="kf-input flex-1" type="number" min={0} max={100} step="0.1"
          placeholder="% לקרנף" value={pct} onChange={(e) => setPct(e.target.value)} />
        <button type="submit" className="kf-btn kf-btn-primary text-sm" disabled={busy}>
          {busy ? 'מוסיף...' : 'הוסף שותף'}
        </button>
      </div>
    </form>
  );
}

function EditDialog({
  partner,
  busy,
  onSubmit,
  onCancel,
}: {
  partner: PartnerRow;
  busy: boolean;
  onSubmit: (patch: { full_name?: string; phone?: string | null; email?: string | null;
    domain?: PartnerDomain; commission_to_karnaf_pct?: number; notes?: string | null }) => void;
  onCancel: () => void;
}) {
  const [fullName, setFullName] = useState(partner.full_name);
  const [phone, setPhone] = useState(partner.phone ?? '');
  const [email, setEmail] = useState(partner.email ?? '');
  const [domain, setDomain] = useState<PartnerDomain>(partner.domain);
  const [pct, setPct] = useState(String(partner.commission_to_karnaf_pct));
  const [notes, setNotes] = useState(partner.notes ?? '');

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSubmit({
      full_name: fullName.trim(),
      phone: phone.trim() || null,
      email: email.trim() || null,
      domain,
      commission_to_karnaf_pct: Number(pct) || 0,
      notes: notes.trim() || null,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <form className="kf-card w-full max-w-lg space-y-3 p-5" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">עריכת שותף</h2>
        <label className="block text-sm">
          <span className="text-slate-600">שם מלא</span>
          <input className="kf-input mt-1" required value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="text-slate-600">טלפון</span>
            <input className="kf-input mt-1" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">אימייל</span>
            <input className="kf-input mt-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="text-slate-600">תחום</span>
            <select className="kf-input mt-1" value={domain} onChange={(e) => setDomain(e.target.value as PartnerDomain)}>
              {Object.entries(DOMAIN_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">% עמלה לקרנף</span>
            <input className="kf-input mt-1" type="number" min={0} max={100} step="0.1"
              value={pct} onChange={(e) => setPct(e.target.value)} />
          </label>
        </div>
        <label className="block text-sm">
          <span className="text-slate-600">הערות</span>
          <textarea className="kf-input mt-1 min-h-[80px]" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="kf-btn" onClick={onCancel}>ביטול</button>
          <button type="submit" className="kf-btn kf-btn-primary" disabled={busy}>{busy ? 'שומר...' : 'שמירה'}</button>
        </div>
      </form>
    </div>
  );
}
