import { useMutation, useQuery } from '@tanstack/react-query';
import { fetchOpsStatus, postTestAlertChannels } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useToast } from '@/components/Toast';
import { LoadFailed } from '@/components/LoadFailed';

// The screen that answers "is the system actually working?" without anyone
// having to read the source or ask for a database query.
//
// It exists because that question had no answer inside the product. The
// dashboard's red banner watched heartbeats and misreported them; the inbox
// rendered a failed fetch as an empty queue; nothing recorded that Meta had
// called; and whether the alert channels were configured at all was
// knowable only from the code. Each of those was a screen stating something
// with more confidence than its data supported.

const LEVEL_CLASS: Record<string, string> = {
  ok: 'kf-tone-success',
  warn: 'kf-tone-warning',
  error: 'kf-tone-danger',
};
const LEVEL_ICON: Record<string, string> = { ok: '✅', warn: '⚠️', error: '🚨' };

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'וואטסאפ',
  email: 'מייל (Resend)',
  telegram: 'טלגרם',
};

export function OpsStatusPage() {
  useDocumentTitle('מצב המערכת');
  const toast = useToast();
  const q = useQuery({
    queryKey: ['ops-status'],
    queryFn: fetchOpsStatus,
    refetchInterval: 60_000,
  });

  const test = useMutation({
    mutationFn: postTestAlertChannels,
    onSuccess: (r) => {
      const ok = Object.entries(r.channels).filter(([, c]) => c.ok).map(([n]) => CHANNEL_LABELS[n] ?? n);
      toast[r.delivered ? 'success' : 'error'](
        r.delivered
          ? `נשלחה בדיקה בהצלחה אל: ${ok.join(', ')}`
          : 'אף ערוץ לא קיבל את הודעת הבדיקה — בדוק את הסודות',
      );
      void q.refetch();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  if (q.isLoading) return <p className="text-slate-500">טוען...</p>;
  if (!q.data) {
    return <LoadFailed error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  }
  const s = q.data;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">מצב המערכת</h1>
        <p className="mt-1 text-sm text-slate-600">
          מתרענן כל דקה. כל מה שמוצג כאן נקרא ישירות מהמערכת — לא הערכה.
        </p>
      </div>

      {/* Verdicts first: the reader should not have to interpret timestamps. */}
      <section className="space-y-2">
        {s.verdicts.map((v) => (
          <div
            key={v.key}
            className={`rounded-lg px-3 py-2 text-sm ring-1 ring-inset ${LEVEL_CLASS[v.level] ?? 'kf-tone-neutral'}`}
            role={v.level === 'error' ? 'alert' : 'status'}
          >
            <span aria-hidden="true" className="me-2">{LEVEL_ICON[v.level]}</span>
            {v.text}
          </div>
        ))}
      </section>

      <section className="kf-card p-4">
        <h2 className="text-base font-semibold">קליטה</h2>
        <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
          <Row k="הודעה נכנסת אחרונה" v={s.intake.lastInboundAt} />
          <Row k="הודעה יוצאת אחרונה" v={s.intake.lastOutboundAt} />
          <Row k="קריאת webhook אחרונה" v={s.intake.lastWebhookAt} />
          <div className="flex items-baseline gap-2">
            <dt className="text-slate-500">ב-24 השעות האחרונות</dt>
            <dd className="text-slate-800 tabular-nums">
              {s.intake.inbound24h ?? '—'} נכנסות · {s.intake.outbound24h ?? '—'} יוצאות
            </dd>
          </div>
        </dl>
      </section>

      <section className="kf-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">ערוצי התראה</h2>
          <button
            type="button"
            className="kf-btn text-sm"
            onClick={() => test.mutate()}
            disabled={test.isPending}
          >
            {test.isPending ? 'שולח...' : 'שלח הודעת בדיקה'}
          </button>
        </div>
        <ul className="mt-2 flex flex-wrap gap-2 text-sm">
          {Object.entries(s.alerts.channels).map(([name, on]) => (
            <li
              key={name}
              className={`rounded-full px-3 py-1 ring-1 ring-inset ${on ? 'kf-tone-success' : 'kf-tone-neutral'}`}
            >
              {on ? '✅' : '⚪'} {CHANNEL_LABELS[name] ?? name}
            </li>
          ))}
        </ul>

        {s.alerts.recent && s.alerts.recent.length > 0 ? (
          <>
            <h3 className="mt-4 text-sm font-medium text-slate-700">התראות אחרונות</h3>
            <ul className="mt-1 divide-y divide-slate-100 text-sm">
              {s.alerts.recent.map((a, i) => (
                <li key={`${a.created_at}-${i}`} className="flex flex-wrap items-baseline gap-2 py-1.5">
                  <span aria-hidden="true">{a.delivered ? '✅' : '❌'}</span>
                  <span className="font-medium text-slate-800">{a.title}</span>
                  <span className="text-xs text-slate-500">{formatRelative(a.created_at)}</span>
                  <span className="text-xs text-slate-400">
                    {Object.entries(a.channel_results ?? {})
                      .map(([n, r]) => `${CHANNEL_LABELS[n] ?? n}: ${r.ok ? 'נשלח' : r.skipped ?? 'נכשל'}`)
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-3 text-sm text-slate-500">
            עוד לא נשלחה אף התראה. אם הגדרת סודות זה עתה — לחץ ״שלח הודעת בדיקה״.
          </p>
        )}
      </section>

      <section className="kf-card p-4">
        <h2 className="text-base font-semibold">תהליכים מתוזמנים</h2>
        {s.workers && s.workers.length > 0 ? (
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {s.workers.map((w) => (
              <li key={w.name} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                <span className="font-medium text-slate-800">{w.name}</span>
                <span className="text-slate-600">
                  {formatRelative(w.last_ok_at)}
                  <span className="ms-2 text-xs text-slate-400">{formatDateTime(w.last_ok_at)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          // Distinct from "all workers are dead" — see DashboardPage for why
          // that distinction matters.
          <p className="mt-2 text-sm text-slate-500">לא ניתן לקרוא את דיווחי החיים.</p>
        )}
      </section>

      <section className="kf-card p-4">
        <h2 className="text-base font-semibold">תור ומשלוח</h2>
        <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
          <div className="flex items-baseline gap-2">
            <dt className="text-slate-500">פריטים ממתינים בתור</dt>
            <dd className="text-slate-800 tabular-nums">{s.queue.pending ?? '—'}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-slate-500">הודעות שנכשלו סופית</dt>
            <dd className={`tabular-nums ${(s.queue.dlq ?? 0) > 0 ? 'font-semibold text-rose-700' : 'text-slate-800'}`}>
              {s.queue.dlq ?? '—'}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string | null }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-slate-500">{k}</dt>
      <dd className="text-slate-800">
        {v ? (
          <>
            {formatRelative(v)}
            <span className="ms-2 text-xs text-slate-400">{formatDateTime(v)}</span>
          </>
        ) : (
          '—'
        )}
      </dd>
    </div>
  );
}
