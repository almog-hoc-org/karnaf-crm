import { useState, useRef, useEffect } from 'react';
import type { Role } from '@/auth/auth-context';

const ROLE_PERMISSIONS: Record<Role, { label: string; can: string[]; cannot: string[] }> = {
  owner: {
    label: 'בעלים',
    can: [
      'גישה מלאה: דאשבורד, לידים, תור, ניתוח, ניהול משתמשים, ניהול פרומפטים',
      'יצירת משתמשים חדשים והגדרת תפקידים',
      'סימון לידים כסגירה / אבוד / DNC',
      'עריכת A/B prompt variants',
    ],
    cannot: ['שינוי הגדרות בסיס נתונים (דורש הרשאות supabase)'],
  },
  admin: {
    label: 'מנהל/ת',
    can: [
      'גישה מלאה לתפעול שוטף',
      'יצירה ועריכה של משתמשים אחרים',
      'עריכת A/B prompt variants',
      'סימון won / lost / DNC',
    ],
    cannot: ['ביטול חשבון בעלים'],
  },
  mia: {
    label: 'מפעיל/ת ראשי/ת (Mia)',
    can: [
      'דאשבורד, לידים, תור, ניתוח',
      'שליחת הודעות ידניות, תיעוד שיחות טלפון',
      'סימון won / lost / DNC, העברת לידים בין AI ל-Mia',
    ],
    cannot: ['ניהול משתמשים', 'עריכת prompt variants'],
  },
  sales_rep: {
    label: 'נציג/ת מכירות',
    can: [
      'צפייה בלידים, תור',
      'שליחת הודעות ידניות',
      'תיעוד שיחות טלפון',
    ],
    cannot: ['סימון won / lost / DNC', 'גישה לניהול משתמשים', 'עריכת prompt variants'],
  },
  viewer: {
    label: 'צופה',
    can: ['צפייה בלידים, תור, דאשבורד וניתוח'],
    cannot: ['כל פעולת כתיבה: סימון, שליחה, עריכה'],
  },
};

export function RoleHelp({ role }: { role: Role }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const info = ROLE_PERMISSIONS[role];

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        className="kf-pressable grid h-5 w-5 place-items-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-600 transition hover:bg-slate-300"
        aria-label="הצגת הרשאות התפקיד"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="הרשאות התפקיד"
          className="absolute end-0 top-7 z-40 w-72 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700 shadow-xl"
        >
          <div className="border-b border-slate-100 pb-2 font-semibold">{info.label}</div>
          <div className="mt-2">
            <div className="text-xs font-semibold text-emerald-700">יכול/ה:</div>
            <ul className="mt-1 list-disc ps-5 text-xs text-slate-600">
              {info.can.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div className="mt-2">
            <div className="text-xs font-semibold text-rose-700">לא יכול/ה:</div>
            <ul className="mt-1 list-disc ps-5 text-xs text-slate-600">
              {info.cannot.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
