import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { fetchReports } from '@/lib/api';
import type {
  CommissionByPartnerRow,
  CommissionMonthlyRow,
  PresaleAtRiskRow,
  RetentionStageRow,
} from '@/lib/types';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { t } from '@/lib/i18n';

type Tab = 'commissions' | 'presale' | 'retention';

const TAB_LABELS: Record<Tab, string> = {
  commissions: 'עמלות',
  presale: 'פריסייל',
  retention: 'שימור',
};

export function ReportsPage() {
  useDocumentTitle('דוחות');
  const q = useQuery({ queryKey: ['reports'], queryFn: fetchReports });

  const [params, setParams] = useSearchParams();
  const initialTab = (params.get('tab') as Tab | null) ?? 'commissions';
  const [tab, setTab] = useState<Tab>(initialTab);

  function selectTab(next: Tab) {
    setTab(next);
    const sp = new URLSearchParams(params);
    sp.set('tab', next);
    setParams(sp, { replace: true });
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">דוחות</h1>
        <button type="button" className="kf-btn kf-btn-ghost text-sm" onClick={() => q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? t('refreshing') : t('refresh')}
        </button>
      </header>

      <nav className="flex gap-1 border-b border-slate-200" role="tablist">
        {(Object.keys(TAB_LABELS) as Tab[]).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => selectTab(id)}
            className={clsx(
              'border-b-2 px-4 py-2 text-sm font-medium transition',
              tab === id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {TAB_LABELS[id]}
          </button>
        ))}
      </nav>

      {q.isLoading ? <p className="text-slate-500">{t('loading')}</p> :
       q.error ? <p className="text-rose-600">{t('error_prefix')}: {(q.error as Error).message}</p> :
       q.data ? (
        <>
          {tab === 'commissions' ? <CommissionsTab monthly={q.data.commissions.monthly} byPartner={q.data.commissions.byPartner} /> : null}
          {tab === 'presale' ? <PresaleTab atRisk={q.data.presale.atRisk} /> : null}
          {tab === 'retention' ? <RetentionTab stages={q.data.retention.stages} /> : null}
        </>
      ) : null}
    </div>
  );
}

// ── Commissions tab ───────────────────────────────────────────────────────

function CommissionsTab({
  monthly,
  byPartner,
}: {
  monthly: CommissionMonthlyRow[];
  byPartner: CommissionByPartnerRow[];
}) {
  // Headline totals across all partners.
  const totals = useMemo(() => {
    let paid = 0, open = 0;
    for (const p of byPartner) { paid += Number(p.paid_total) || 0; open += Number(p.open_total) || 0; }
    return { paid, open };
  }, [byPartner]);

  // Group monthly by month, pivot into status columns. Used for a
  // simple stacked bar by month.
  const byMonth = useMemo(() => {
    const m = new Map<string, { month: string; paid: number; open: number; pending: number }>();
    for (const row of monthly) {
      const key = row.month;
      const existing = m.get(key) ?? { month: key, paid: 0, open: 0, pending: 0 };
      if (row.status === 'paid') existing.paid += Number(row.amount_total) || 0;
      else if (row.status === 'to_bill') existing.open += Number(row.amount_total) || 0;
      else if (row.status === 'pending') existing.pending += Number(row.amount_total) || 0;
      m.set(key, existing);
    }
    // Newest first → reverse for left-to-right chronology.
    return Array.from(m.values()).reverse();
  }, [monthly]);

  const maxAmount = useMemo(
    () => Math.max(1, ...byMonth.map((r) => r.paid + r.open + r.pending)),
    [byMonth],
  );

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <KpiTile label="עמלות ששולמו (סה״כ)" value={totals.paid.toLocaleString('he-IL')} suffix="₪" />
        <KpiTile label="פתוחות לחיוב" value={totals.open.toLocaleString('he-IL')} suffix="₪" tone="warn" />
        <KpiTile label="שותפים פעילים" value={byPartner.filter((p) => p.commissions_count > 0).length.toString()} />
        <KpiTile label="חודשים עם פעילות" value={byMonth.length.toString()} />
      </section>

      <section className="kf-card p-4">
        <h2 className="text-lg font-semibold">מגמת עמלות לפי חודש</h2>
        {byMonth.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">אין עדיין נתוני עמלות.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {byMonth.map((m) => {
              const monthLabel = new Date(m.month).toLocaleDateString('he-IL', { year: 'numeric', month: 'long' });
              const total = m.paid + m.open + m.pending;
              return (
                <li key={m.month}>
                  <div className="flex items-baseline justify-between text-xs text-slate-500">
                    <span>{monthLabel}</span>
                    <span className="tabular-nums">{total.toLocaleString('he-IL')} ₪</span>
                  </div>
                  <div className="mt-1 flex h-3 overflow-hidden rounded-full bg-slate-100">
                    <div className="bg-emerald-500" style={{ width: `${(m.paid / maxAmount) * 100}%` }} title={`שולם ${m.paid.toLocaleString('he-IL')}`} />
                    <div className="bg-rose-400" style={{ width: `${(m.open / maxAmount) * 100}%` }} title={`לחיוב ${m.open.toLocaleString('he-IL')}`} />
                    <div className="bg-amber-300" style={{ width: `${(m.pending / maxAmount) * 100}%` }} title={`ממתינה ${m.pending.toLocaleString('he-IL')}`} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3 flex gap-3 text-xs text-slate-500">
          <span><span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> שולם</span>
          <span><span className="inline-block h-2 w-2 rounded-full bg-rose-400" /> לחיוב</span>
          <span><span className="inline-block h-2 w-2 rounded-full bg-amber-300" /> ממתינה</span>
        </div>
      </section>

      <section className="kf-card overflow-hidden p-4">
        <h2 className="text-lg font-semibold">שותפים — ביצועים</h2>
        <p className="text-xs text-slate-500">ממוצע ימים-לתשלום משקף את מהירות גביית העמלות מהשותף.</p>
        <div className="mt-3 -mx-4 overflow-x-auto sm:mx-0">
          <table className="kf-table min-w-[44rem]">
            <thead>
              <tr>
                <th>שותף</th>
                <th>תחום</th>
                <th>שולמו</th>
                <th>פתוחות</th>
                <th>סכום ששולם</th>
                <th>סכום פתוח</th>
                <th>ממ' ימים לתשלום</th>
              </tr>
            </thead>
            <tbody>
              {byPartner.length === 0 ? (
                <tr><td colSpan={7} className="p-4 text-center text-slate-500">אין שותפים פעילים.</td></tr>
              ) : byPartner.map((p) => (
                <tr key={p.partner_id}>
                  <td className="font-medium">{p.full_name}</td>
                  <td className="text-slate-500">{p.domain}</td>
                  <td className="tabular-nums">{p.paid_count}</td>
                  <td className="tabular-nums">{p.open_count}</td>
                  <td className="tabular-nums text-emerald-700">{Number(p.paid_total).toLocaleString('he-IL')}</td>
                  <td className="tabular-nums text-rose-700">{Number(p.open_total).toLocaleString('he-IL')}</td>
                  <td className="tabular-nums">{p.avg_days_to_paid !== null ? Number(p.avg_days_to_paid).toFixed(1) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ── Presale tab ───────────────────────────────────────────────────────────

function PresaleTab({ atRisk }: { atRisk: PresaleAtRiskRow[] }) {
  const counts = useMemo(() => {
    const acc = { ok: 0, amber: 0, red: 0, overdue: 0 };
    for (const r of atRisk) acc[r.risk_level]++;
    return acc;
  }, [atRisk]);

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <KpiTile label="פרויקטים מגוייסים" value={atRisk.length.toString()} />
        <KpiTile label="באיחור" value={counts.overdue.toString()} tone={counts.overdue > 0 ? 'danger' : 'normal'} />
        <KpiTile label="אדום (פחות מ-14 יום + מתחת 80%)" value={counts.red.toString()} tone={counts.red > 0 ? 'danger' : 'normal'} />
        <KpiTile label="צהוב (מתחת 50% גיוס)" value={counts.amber.toString()} tone={counts.amber > 0 ? 'warn' : 'normal'} />
      </section>

      <section className="kf-card p-4">
        <h2 className="text-lg font-semibold">פרויקטים — סטטוס סיכון</h2>
        {atRisk.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">אין פרויקטים במצב גיוס. <Link to="/projects" className="text-brand-700 hover:underline">פתיחת פרויקטים</Link></p>
        ) : (
          <ul className="mt-3 space-y-2">
            {atRisk.map((p) => (
              <li key={p.project_id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link to={`/projects`} className="text-sm font-medium hover:text-brand-700">{p.name}</Link>
                  <RiskBadge risk={p.risk_level} />
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {p.city ? `${p.city} · ` : ''}
                  גויס {Number(p.committed_amount).toLocaleString('he-IL')} {p.currency}
                  {p.target_amount ? ` מתוך ${Number(p.target_amount).toLocaleString('he-IL')}` : ''}
                  {p.funding_pct !== null ? ` (${p.funding_pct}%)` : ''}
                </div>
                {p.target_date ? (
                  <div className={clsx(
                    'mt-1 text-xs',
                    p.days_to_target !== null && p.days_to_target < 0 && 'text-rose-700',
                    p.days_to_target !== null && p.days_to_target >= 0 && p.days_to_target < 14 && 'text-amber-700',
                  )}>
                    תאריך יעד: {p.target_date}
                    {p.days_to_target !== null ? ` (${p.days_to_target < 0 ? `${-p.days_to_target} ימים באיחור` : `${p.days_to_target} ימים נותרו`})` : ''}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RiskBadge({ risk }: { risk: PresaleAtRiskRow['risk_level'] }) {
  const tone =
    risk === 'overdue' ? 'bg-rose-100 text-rose-800 ring-rose-300' :
    risk === 'red' ? 'bg-rose-50 text-rose-700 ring-rose-200' :
    risk === 'amber' ? 'bg-amber-50 text-amber-800 ring-amber-200' :
    'bg-emerald-50 text-emerald-700 ring-emerald-200';
  const label =
    risk === 'overdue' ? 'באיחור' :
    risk === 'red' ? 'אדום' :
    risk === 'amber' ? 'צהוב' : 'תקין';
  return <span className={clsx('rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', tone)}>{label}</span>;
}

// ── Retention tab ─────────────────────────────────────────────────────────

function RetentionTab({ stages }: { stages: RetentionStageRow[] }) {
  const totals = useMemo(() => {
    let members = 0, active = 0, dormant = 0;
    for (const s of stages) { members += s.members_count; active += s.active_count; dormant += s.dormant_count; }
    return { members, active, dormant, activePct: members === 0 ? null : Math.round((active / members) * 1000) / 10 };
  }, [stages]);

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <KpiTile label="חברים בתוכנית" value={totals.members.toString()} />
        <KpiTile label="פעילים (30 יום)" value={totals.active.toString()} tone="ok" />
        <KpiTile label="רדומים (30+ יום)" value={totals.dormant.toString()} tone={totals.dormant > 0 ? 'warn' : 'normal'} />
        <KpiTile label="אחוז פעילות" value={totals.activePct !== null ? `${totals.activePct}%` : '—'} />
      </section>

      <section className="kf-card p-4">
        <h2 className="text-lg font-semibold">פילוח לפי שלב התקדמות</h2>
        <p className="text-xs text-slate-500">משך 30 יום — שלבים בהם רוב החברים רדומים מסמנים מקום שצריך התערבות.</p>
        {stages.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">אין עדיין חברים בתוכנית.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {stages.map((s) => {
              const pct = s.active_pct ?? 0;
              const tone = pct >= 70 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-400' : 'bg-rose-400';
              return (
                <li key={s.progress_stage}>
                  <div className="flex items-baseline justify-between text-sm">
                    <strong>{s.progress_stage}</strong>
                    <span className="tabular-nums text-slate-500">
                      {s.active_count}/{s.members_count} פעילים{s.active_pct !== null ? ` (${s.active_pct}%)` : ''}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div className={clsx('h-full', tone)} style={{ width: `${Math.min(100, pct)}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

// ── Shared bits ───────────────────────────────────────────────────────────

function KpiTile({
  label,
  value,
  suffix,
  tone = 'normal',
}: {
  label: string;
  value: string;
  suffix?: string;
  tone?: 'normal' | 'ok' | 'warn' | 'danger';
}) {
  const toneCls =
    tone === 'ok' ? 'text-emerald-700' :
    tone === 'warn' ? 'text-amber-700' :
    tone === 'danger' ? 'text-rose-700' : 'text-slate-900';
  return (
    <div className="kf-card p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={clsx('mt-1 text-2xl font-semibold tabular-nums', toneCls)}>
        {value}{suffix ? <span className="text-base font-normal text-slate-500"> {suffix}</span> : null}
      </div>
    </div>
  );
}
