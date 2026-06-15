import { useQuery } from '@tanstack/react-query';
import { fetchTeamWorkload, type TeamMember } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { t } from '@/lib/i18n';

const ROLE_LABELS: Record<TeamMember['role'], string> = {
  owner: 'בעלים',
  admin: 'אדמין',
  mia: 'נציג',
  sales_rep: 'איש מכירות',
  viewer: 'צופה',
};

export function TeamPage() {
  useDocumentTitle(t('nav_team'));
  const q = useQuery({
    queryKey: ['team-workload'],
    queryFn: () => fetchTeamWorkload(),
    staleTime: 60_000,
  });

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{t('nav_team')}</h1>
        <span className="text-sm text-slate-500">
          {q.data?.length ?? 0} משתמשים
        </span>
      </header>

      <p className="text-sm text-slate-500">
        מצב נוכחי של כל איש צוות פעיל: כמה לידים פתוחים הוא מטפל בהם וכמה
        פעולות הוא ביצע ב-7 הימים האחרונים.
      </p>

      <div className="kf-card overflow-hidden md:overflow-visible">
        <table className="kf-table kf-table-responsive">
          <thead>
            <tr>
              <th>שם</th>
              <th>אימייל</th>
              <th>תפקיד</th>
              <th>סטטוס</th>
              <th>לידים פעילים</th>
              <th>פעולות (7 ימים)</th>
              <th>פעיל לאחרונה</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              <tr><td colSpan={7} className="p-6 text-center text-slate-500">{t('loading')}</td></tr>
            ) : q.error ? (
              <tr><td colSpan={7} className="p-6 text-center text-rose-600">
                {t('error_prefix')}: {(q.error as Error).message}
              </td></tr>
            ) : q.data && q.data.length > 0 ? (
              q.data.map((m) => (
                <tr key={m.user_id} className={m.is_active ? undefined : 'opacity-60'}>
                  <td data-primary>
                    <span className="font-medium text-slate-800">{m.full_name || '—'}</span>
                  </td>
                  <td data-label="אימייל" className="text-slate-600 break-all">{m.email || '—'}</td>
                  <td data-label="תפקיד">
                    <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                      {ROLE_LABELS[m.role]}
                    </span>
                  </td>
                  <td data-label="סטטוס">
                    {m.is_active ? (
                      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">פעיל</span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">מושתק</span>
                    )}
                  </td>
                  <td data-label="לידים פעילים" className="tabular-nums">{m.active_leads_owned}</td>
                  <td data-label="פעולות (7 ימים)" className="tabular-nums">{m.recent_touches_7d}</td>
                  <td data-label="פעיל לאחרונה" className="text-slate-500">
                    {m.last_active_at ? formatRelative(m.last_active_at) : '—'}
                  </td>
                </tr>
              ))
            ) : (
              <tr><td colSpan={7} className="p-10 text-center text-slate-500">אין חברי צוות.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
