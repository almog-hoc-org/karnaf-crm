import { useQuery } from '@tanstack/react-query';
import { fetchDashboardSummary, fetchQueueList } from '@/lib/api';
import type { DashboardSummary, QueueRow } from '@/lib/types';
import { QUEUE_LABELS } from '@/lib/format';
import { Link } from 'react-router-dom';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { t } from '@/lib/i18n';
import { useAuth } from '@/auth/auth-context';
import { WelcomeCard } from '@/components/WelcomeCard';

export function DashboardPage() {
  const auth = useAuth();
  const summaryQ = useQuery({ queryKey: ['dashboard-summary'], queryFn: fetchDashboardSummary });
  const queueQ = useQuery({ queryKey: ['queue', 'pending'], queryFn: () => fetchQueueList({ status: 'pending' }) });
  useDocumentTitle(t('dashboard_title'));

  if (summaryQ.isLoading) return <p className="text-slate-500">{t('loading')}</p>;
  if (summaryQ.error) return <p className="text-rose-600">{t('error_prefix')}: {(summaryQ.error as Error).message}</p>;

  const s = summaryQ.data!;

  return (
    <div className="space-y-4 sm:space-y-6">
      <WelcomeCard role={auth.role} userEmail={auth.user?.email ?? null} />
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{t('dashboard_title')}</h1>
        <button
          type="button" className="kf-btn kf-btn-ghost shrink-0"
          onClick={() => { summaryQ.refetch(); queueQ.refetch(); }}
          disabled={summaryQ.isFetching || queueQ.isFetching}
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path strokeLinecap="round" d="M3 10a7 7 0 0 1 12-5l2 2M17 10a7 7 0 0 1-12 5l-2-2" />
            <path strokeLinecap="round" d="M14 5h3V2M6 15H3v3" />
          </svg>
          <span className="hidden sm:inline">{summaryQ.isFetching || queueQ.isFetching ? t('refreshing') : t('refresh')}</span>
        </button>
      </header>

      <TodayCommandCenter summary={s} queues={queueQ.data ?? []} queuesLoading={queueQ.isLoading} />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard label={t('kpi_leads_today')} value={s.leadsToday} icon={<IconSparkles />} />
        <KpiCard label={t('kpi_unanswered')} value={s.unansweredNow} tone={s.unansweredNow > 0 ? 'warn' : 'normal'}
                 to="/inbox?lane=reply" icon={<IconClock />} />
        <KpiCard label={t('kpi_hot_leads')} value={s.hotLeadsNow} tone={s.hotLeadsNow > 0 ? 'hot' : 'normal'}
                 to="/leads?heat=hot" icon={<IconFlame />} />
        <KpiCard label={t('kpi_payment_pending')} value={s.paymentPendingNow}
                 to="/leads?status=payment_pending" icon={<IconCreditCard />} />
        <KpiCard label={t('kpi_sla_risk')} value={s.slaRiskCount} tone={s.slaRiskCount > 0 ? 'warn' : 'normal'}
                 to="/inbox?lane=risk" icon={<IconAlert />} />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="kf-card p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">{t('conversion_funnel')}</h2>
            <span className="hidden text-xs text-slate-500 sm:inline">{t('conversion_step_over_step')}</span>
          </div>
          <FunnelBars funnel={s.funnel} />
        </div>

        <div className="kf-card p-4 sm:p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">{t('pending_queues')}</h2>
            <Link to="/queue" className="text-xs text-brand-700 hover:underline">{t('to_all_queues')}</Link>
          </div>
          {queueQ.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">{t('loading')}</p>
          ) : queueQ.data && queueQ.data.length > 0 ? (
            <ul className="mt-3 divide-y divide-slate-100">
              {queueQ.data.slice(0, 8).map((q) => (
                <li key={q.id} className="flex items-center justify-between gap-3 py-2">
                  <Link to={`/leads/${q.lead_id}`} className="min-w-0 flex-1 truncate text-sm text-slate-700 hover:text-brand-700">
                    <strong>{QUEUE_LABELS[q.queue_type] ?? q.queue_type}</strong>
                    <span className="text-slate-500"> · {q.leads?.full_name ?? '—'}</span>
                  </Link>
                  <span className="inline-flex items-center gap-1 text-xs text-slate-500" title={`${t('priority')} ${q.priority_level}`}>
                    <PriorityDot priority={q.priority_level} />
                    {t('priority')} {q.priority_level}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyStateGuidance />
          )}
        </div>
      </section>

      <section className="kf-card p-4 sm:p-5">
        <h2 className="text-lg font-semibold">{t('queues_by_type')}</h2>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          {Object.entries(s.queueCounts).map(([key, count]) => (
            <Link
              key={key} to={`/queue?type=${encodeURIComponent(key)}`}
              className="group rounded-lg bg-slate-50 p-3 ring-1 ring-transparent transition hover:bg-white hover:ring-slate-200"
            >
              <div className="text-xs text-slate-500 group-hover:text-slate-600">{QUEUE_LABELS[key] ?? key}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{count}</div>
            </Link>
          ))}
        </div>
      </section>

      <SourceHealthSection sourceHealth={s.sourceHealth} />
    </div>
  );
}

function TodayCommandCenter({
  summary, queues, queuesLoading,
}: {
  summary: DashboardSummary;
  queues: QueueRow[];
  queuesLoading: boolean;
}) {
  const priority = todayPriority(summary, queues);
  const topQueues = queues.slice(0, 3);
  return (
    <section className="overflow-hidden rounded-3xl border border-brand-100 bg-gradient-to-l from-brand-50 via-white to-white shadow-sm">
      <div className="grid gap-0 lg:grid-cols-[1.3fr_0.9fr]">
        <div className="p-4 sm:p-6">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-100">
            <span aria-hidden="true">🎯</span>
            ניהול היום
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-950">{priority.title}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{priority.detail}</p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Link to={priority.href} className="kf-btn kf-btn-primary justify-center">{priority.cta}</Link>
            <Link to="/inbox" className="kf-btn justify-center">פתיחת מסך טיפול</Link>
            <Link to="/leads?heat=hot" className="kf-btn kf-btn-ghost justify-center">לידים חמים</Link>
          </div>
        </div>
        <div className="border-t border-brand-100 bg-white/70 p-4 sm:p-6 lg:border-s lg:border-t-0">
          <h3 className="text-sm font-semibold text-slate-700">הבא בתור</h3>
          {queuesLoading ? (
            <p className="mt-3 text-sm text-slate-500">טוען משימות...</p>
          ) : topQueues.length > 0 ? (
            <ol className="mt-3 space-y-2">
              {topQueues.map((q, i) => (
                <li key={q.id}>
                  <Link to={`/leads/${q.lead_id}`} className="flex items-center gap-3 rounded-xl bg-white p-3 text-sm shadow-sm ring-1 ring-slate-100 transition hover:ring-brand-200">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-slate-800">{q.leads?.full_name ?? 'ליד ללא שם'}</span>
                      <span className="block truncate text-xs text-slate-500">{QUEUE_LABELS[q.queue_type] ?? q.queue_type}</span>
                    </span>
                    <PriorityDot priority={q.priority_level} />
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">אין משימות דחופות. כדאי לעבור על לידים חמים ולוודא שאין שיחות רגישות.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function todayPriority(summary: DashboardSummary, queues: QueueRow[]) {
  const first = queues[0];
  if (summary.unansweredNow > 0) {
    return {
      title: `להתחיל מ-${summary.unansweredNow} לידים שמחכים למענה`,
      detail: 'זה המקום שבו הכי קל לאבד לקוח. עברי לפי הסדר, עני או העבירי לשיחה, וסגרי כל פריט שטופל.',
      cta: 'לטפל בממתינים למענה',
      href: '/inbox?lane=reply',
    };
  }
  if (summary.slaRiskCount > 0) {
    return {
      title: `יש ${summary.slaRiskCount} פריטי סיכון שדורשים בדיקה`,
      detail: 'בדקי קודם פריטים בסיכון SLA או אוטומציה תקועה, כדי לוודא שאף ליד לא נופל בין הכיסאות.',
      cta: 'לפתוח פריטי סיכון',
      href: '/inbox?lane=risk',
    };
  }
  if (summary.paymentPendingNow > 0) {
    return {
      title: `יש ${summary.paymentPendingNow} לקוחות שממתינים לתשלום`,
      detail: 'אלה לידים קרובים לסגירה. כדאי לבדוק אם צריך דחיפה עדינה, קישור חדש או שיחת סגירה.',
      cta: 'לטפל בתשלומים ממתינים',
      href: '/leads?status=payment_pending',
    };
  }
  if (first) {
    return {
      title: 'יש עבודה מסודרת בתור — להתחיל מהפריט הראשון',
      detail: `${first.leads?.full_name ?? 'הליד הראשון'} נמצא בראש הרשימה בגלל עדיפות ${first.priority_level}.`,
      cta: 'לפתוח את הפריט הראשון',
      href: `/leads/${first.lead_id}`,
    };
  }
  return {
    title: 'היום נראה בשליטה',
    detail: 'אין כרגע פריטים דחופים. זה זמן טוב לסקירת לידים חמים, איכות מקורות ושיחות שנפתרו היום.',
    cta: 'סקירת לידים חמים',
    href: '/leads?heat=hot',
  };
}

function SourceHealthSection({
  sourceHealth,
}: { sourceHealth: DashboardSummary['sourceHealth'] }) {
  const entries = Object.entries(sourceHealth ?? {})
    .map(([source, v]) => ({ source, h24: v.h24, d7: v.d7 }))
    .sort((a, b) => b.d7 - a.d7 || b.h24 - a.h24);
  return (
    <section className="kf-card p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">בריאות מקורות לידים</h2>
        <Link to="/admin/sources" className="text-xs text-brand-700 hover:underline">ניהול מקורות</Link>
      </div>
      {entries.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">לא נכנסו לידים בטווח האחרון.</p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map(({ source, h24, d7 }) => (
            <Link
              key={source}
              to={`/leads?source=${encodeURIComponent(source)}`}
              className="group flex items-baseline justify-between rounded-lg bg-slate-50 p-3 ring-1 ring-transparent transition hover:bg-white hover:ring-slate-200"
              title={source}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-700">{source}</div>
                <div className="text-[11px] text-slate-500">24 שעות אחרונות / 7 ימים אחרונים</div>
              </div>
              <div className="text-end tabular-nums">
                <div className="text-2xl font-semibold text-slate-900">{h24}</div>
                <div className="text-xs text-slate-500">{d7} שבוע</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function KpiCard({
  label, value, tone = 'normal', to, icon,
}: {
  label: string; value: number; tone?: 'normal' | 'warn' | 'hot';
  to?: string; icon?: React.ReactNode;
}) {
  const toneClass = tone === 'hot' ? 'text-rose-700' : tone === 'warn' ? 'text-amber-700' : 'text-slate-900';
  const accent = tone === 'hot' ? 'bg-rose-50 text-rose-600'
    : tone === 'warn' ? 'bg-amber-50 text-amber-600'
    : 'bg-brand-50 text-brand-600';
  const body = (
    <div className="kf-card flex items-start justify-between gap-3 p-4 transition group-hover:shadow-md">
      <div>
        <div className="text-xs text-slate-500">{label}</div>
        <div className={`mt-1 text-3xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      </div>
      {icon ? (
        <span aria-hidden="true" className={`grid h-9 w-9 place-items-center rounded-lg ${accent}`}>{icon}</span>
      ) : null}
    </div>
  );
  if (to) return <Link to={to} className="group block">{body}</Link>;
  return <div>{body}</div>;
}

function FunnelBars({ funnel }: { funnel: DashboardSummary['funnel'] }) {
  const entries: Array<[string, string, number]> = [
    ['חדשים', 'new_count', funnel.new_count],
    ['נשלחה הודעה', 'first_contact_count', funnel.first_contact_count],
    ['הגיב', 'responded_count', funnel.responded_count],
    ['הוסמך', 'qualified_count', funnel.qualified_count],
    ['קישור רכישה', 'checkout_count', funnel.checkout_count],
    ['ממתין לתשלום', 'payment_pending_count', funnel.payment_pending_count],
    ['נסגר ברכישה', 'won_count', funnel.won_count],
    ['אבד', 'lost_count', funnel.lost_count],
  ];
  const max = Math.max(1, ...entries.map(([, , v]) => v));
  return (
    <div className="mt-3 space-y-2">
      {entries.map(([label, key, value], i) => {
        const prev = i > 0 ? entries[i - 1]![2] : null;
        const conv = prev != null && prev > 0 ? Math.round((value / prev) * 100) : null;
        return (
          <div key={key}>
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>{label}</span>
              <span className="flex items-center gap-2 tabular-nums">
                {conv != null ? (
                  <span className="text-[10px] text-slate-400">{conv}% מהשלב הקודם</span>
                ) : null}
                <span className="font-medium">{value}</span>
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded bg-slate-100">
              <div
                className="h-full rounded bg-gradient-to-l from-brand-500 to-brand-600 transition-[width] duration-500"
                style={{ width: `${Math.round((value / max) * 100)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EmptyStateGuidance() {
  return (
    <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/40 p-4 text-sm text-slate-700">
      <div className="flex items-center gap-2">
        <svg viewBox="0 0 20 20" className="h-5 w-5 text-emerald-500" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 10.5 9 14l6-7" />
        </svg>
        <span className="font-medium text-emerald-800">אין משימות פתוחות. הנה צעדים מומלצים:</span>
      </div>
      <ol className="mt-2 list-decimal space-y-1 ps-6 text-slate-600">
        <li>
          <Link to="/leads?heat=hot" className="text-brand-700 hover:underline">בדיקת לידים חמים</Link>
          {' '}— ודא שהבוט מתקדם איתם או שמיה יודעת לקחת.
        </li>
        <li>
          <Link to="/leads" className="text-brand-700 hover:underline">סקירת לידים חדשים מהשעה האחרונה</Link>
          {' '}— מקור / heat / סטטוס בכניסה.
        </li>
        <li>
          <Link to="/queue?status=resolved" className="text-brand-700 hover:underline">סקירת פריטי תור שנסגרו היום</Link>
          {' '}— זיהוי חזרות שמצדיקות שיפור בוט.
        </li>
      </ol>
    </div>
  );
}

function PriorityDot({ priority }: { priority: number }) {
  // work_queue.priority_level is constrained to 1-5; lower number = more urgent.
  const tone =
    priority <= 1 ? 'bg-rose-500' :
    priority <= 2 ? 'bg-amber-500' :
    'bg-slate-300';
  return <span aria-hidden="true" className={`kf-dot ${tone}`} />;
}

function IconSparkles() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path strokeLinecap="round" d="M10 3v3M10 14v3M3 10h3M14 10h3M5 5l2 2M13 13l2 2M15 5l-2 2M7 13l-2 2" />
    </svg>
  );
}
function IconClock() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="10" cy="10" r="7" /><path strokeLinecap="round" d="M10 6v4l3 2" />
    </svg>
  );
}
function IconFlame() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor">
      <path d="M10 2c.6 2.7 4 4 4 7.5a4 4 0 1 1-8 0c0-1.6.7-2.4 1.4-3.2C8.5 5 9.5 4 10 2Zm-1 13a2 2 0 1 1 2-2c0 .8-.5 1.4-1 1.7-.5.2-1 .2-1 .3Z" />
    </svg>
  );
}
function IconCreditCard() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="2.5" y="5" width="15" height="10" rx="2" /><path d="M2.5 9h15M5 13h3" />
    </svg>
  );
}
function IconAlert() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M10 3l8 14H2L10 3Z" /><path strokeLinecap="round" d="M10 9v3M10 14v0.5" />
    </svg>
  );
}
