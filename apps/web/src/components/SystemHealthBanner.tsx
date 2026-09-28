import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { fetchHeartbeats } from '@/lib/api';

// Heartbeat health. Every scheduled worker that can silently stop is
// watched, with a threshold matched to its cron cadence.
//
// A MISSING row counts as stale: a worker that has never once succeeded
// is the most broken state there is, and it used to read as healthy.
const WATCHED_WORKERS: Array<{ name: string; label: string; maxAgeMs: number }> = [
  { name: 'automation_tick', label: 'מנוע אוטומציות', maxAgeMs: 15 * 60_000 },
  { name: 'sla_worker', label: 'מעקב זמני תגובה', maxAgeMs: 30 * 60_000 },
  { name: 'ai_watchdog', label: 'שומר AI', maxAgeMs: 20 * 60_000 },
  { name: 'nightly_jobs', label: 'עבודות לילה', maxAgeMs: 26 * 60 * 60_000 },
];

// Renders nothing while everything is healthy — the owner's daily screen
// should only talk about the system when the system needs them. Shared by
// the "היום" screen and the business-status dashboard.
export function SystemHealthBanner({
  showStatusLink = false,
  quietWhenUnknown = false,
}: {
  showStatusLink?: boolean;
  // The daily screen only speaks up when a worker is known to be down; "we
  // couldn't read the status" is for the status-minded screens.
  quietWhenUnknown?: boolean;
}) {
  const heartbeatsQ = useQuery({
    queryKey: ['heartbeats'],
    queryFn: fetchHeartbeats,
    refetchInterval: 60_000,
  });

  // An EMPTY result is not four dead workers — it is far more likely an RLS
  // filter or a failed request, and rendering "כל התהליכים לא רצים" over a
  // perfectly healthy system is worse than saying nothing, because it
  // teaches the operator to ignore the banner. Distinguish the two.
  // A banner must never be the thing that breaks the page: anything that
  // isn't an array (a proxy's `{}`, an HTML error page) reads as
  // "unavailable", not as a crash of the whole screen it sits on.
  const rows = Array.isArray(heartbeatsQ.data) ? heartbeatsQ.data : null;
  const unavailable = !!heartbeatsQ.error
    || (heartbeatsQ.data !== undefined && (!rows || rows.length === 0));
  const stale = rows && !unavailable
    ? WATCHED_WORKERS.filter((w) => {
      const hb = rows.find((h) => h.name === w.name);
      if (!hb) return true;
      return Date.now() - Date.parse(hb.last_ok_at) > w.maxAgeMs;
    })
    : [];
  const lastOkFor = (name: string) => rows?.find((h) => h.name === name)?.last_ok_at ?? null;

  if (unavailable) {
    if (quietWhenUnknown) return null;
    return (
      <section className="kf-tone-warning rounded-xl p-4 text-sm ring-1 ring-inset" role="status">
        <strong className="block text-base">מצב התהליכים המתוזמנים לא זמין</strong>
        <p className="mt-1">
          לא הצלחנו לקרוא את דיווחי החיים של העובדים. ייתכן שזו תקלת הרשאות או תקלת רשת —
          זה לא אומר שהתהליכים אינם רצים.
        </p>
      </section>
    );
  }
  if (stale.length === 0) return null;
  return (
    <section className="kf-tone-danger rounded-xl p-4 text-sm ring-1 ring-inset" role="alert">
      <strong className="block text-base">⚠️ תהליכים מתוזמנים לא רצים</strong>
      <ul className="mt-1 space-y-0.5 text-sm">
        {stale.map((w) => {
          const lastOk = lastOkFor(w.name);
          return (
            <li key={w.name}>
              {w.label} — ריצה אחרונה:{' '}
              <span className="tabular-nums">
                {lastOk ? new Date(lastOk).toLocaleString('he-IL') : 'אף פעם'}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-sm">
        אוטומציות ותזכורות לא יוצאות עד שזה חוזר.{' '}
        {showStatusLink ? <Link to="/admin/status" className="font-semibold underline">למסך מצב המערכת</Link> : null}
      </p>
    </section>
  );
}
