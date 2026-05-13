import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Role } from '@/auth/auth-context';

const STORAGE_KEY = 'karnaf:welcome-dismissed';

export function WelcomeCard({ role, userEmail }: { role: Role | null; userEmail: string | null }) {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      const value = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : '1';
      setDismissed(value === '1');
    } catch {
      setDismissed(true);
    }
  }, []);

  if (dismissed || !role) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* ignore */
    }
    setDismissed(true);
  }

  const isAdmin = role === 'owner' || role === 'admin';

  return (
    <section
      className="kf-card border-2 border-brand-200 bg-brand-50/30 p-4 sm:p-5"
      aria-labelledby="welcome-heading"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id="welcome-heading" className="text-lg font-semibold text-brand-800">
          ברוכים הבאים ל-Karnaf CRM
        </h2>
        <button
          type="button"
          className="kf-btn kf-btn-ghost text-xs"
          onClick={dismiss}
          aria-label="סגירת מסך הברוכים הבאים"
        >
          הבנתי, סגור
        </button>
      </div>
      {userEmail ? (
        <p className="mt-1 text-sm text-slate-600">היי {userEmail.split('@')[0]} — הנה איך להתחיל:</p>
      ) : null}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <WelcomeStep
          to="/queue"
          title="התור שלך"
          description="כל המשימות הפתוחות מסודרות לפי SLA."
        />
        <WelcomeStep
          to="/leads?heat=hot"
          title="לידים חמים"
          description="לידים שדורשים תשומת לב מיידית."
        />
        <WelcomeStep
          to="/analytics"
          title="ניתוח"
          description="מקור, conversion, ו-AI מול אדם."
        />
        {isAdmin ? (
          <WelcomeStep
            to="/prompts"
            title="פרומפטים"
            description="עריכת התסריטים שה-AI עובד איתם."
          />
        ) : (
          <WelcomeStep
            to="/leads"
            title="כל הלידים"
            description="חיפוש, סינון, וצפייה בכל הלידים."
          />
        )}
      </div>
      <p className="mt-3 text-xs text-slate-500">
        מדריך מלא בעברית: <code className="rounded bg-white px-1.5 py-0.5">docs/operator-guide.md</code>
      </p>
    </section>
  );
}

function WelcomeStep({ to, title, description }: { to: string; title: string; description: string }) {
  return (
    <Link
      to={to}
      className="block rounded-lg border border-slate-200 bg-white p-3 transition hover:border-brand-300 hover:shadow-sm"
    >
      <div className="font-medium text-slate-800">{title}</div>
      <div className="mt-1 text-xs text-slate-500">{description}</div>
    </Link>
  );
}
