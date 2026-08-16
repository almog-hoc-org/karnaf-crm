/* eslint-disable react-refresh/only-export-components -- the option
   lists are exported on purpose; see the comment above them. */
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { usePresence } from '@/lib/usePresence';
import { HEAT_LABELS } from '@/lib/format';
import type { IntakeSegment, LeadHeat } from '@/lib/types';

// One-click classification without opening the lead: a popover with two
// chip rows — heat and treatment track — each a single click. Shell
// follows SnoozePopover (outside-click + Escape + kf-layer presence).
//
// These option lists are THE lists: LeadDetailPage imports them for its
// sidebar selects so the quick path and the full path can't drift.
export const HEAT_QUICK_OPTIONS: Array<{ value: LeadHeat; label: string }> = (
  ['hot', 'warm', 'cool', 'cold'] as LeadHeat[]
).map((value) => ({ value, label: HEAT_LABELS[value] ?? value }));

export const SEGMENT_QUICK_OPTIONS: Array<{ value: IntakeSegment; label: string }> = [
  { value: 'hot_sales', label: 'מכירה חמה' },
  { value: 'needs_human', label: 'נציג אנושי' },
  { value: 'needs_nurture', label: 'טיפוח/הבשלה' },
  { value: 'info_seeker', label: 'מחפש מידע' },
  { value: 'support_or_existing', label: 'תמיכה/קיים' },
  { value: 'unknown', label: 'לא ידוע' },
];

export function QuickClassifyPopover({
  heat,
  segment,
  busy,
  onSetHeat,
  onSetSegment,
  buttonClassName,
  label = 'סיווג ⚡',
}: {
  heat: LeadHeat | null | undefined;
  segment: IntakeSegment | null | undefined;
  busy?: boolean;
  onSetHeat: (heat: LeadHeat) => void;
  onSetSegment: (segment: IntakeSegment) => void;
  buttonClassName?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { mounted, state } = usePresence(open);

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

  const chip = (active: boolean) =>
    clsx(
      'kf-pressable rounded-md px-2 py-1.5 text-xs transition',
      active
        ? 'bg-brand-600 font-semibold text-white'
        : 'border border-slate-200 bg-slate-50 hover:bg-brand-50 hover:text-brand-700',
    );

  return (
    <div className="relative inline-block" ref={containerRef}>
      <button
        type="button"
        className={buttonClassName ?? 'kf-btn kf-btn-ghost text-xs'}
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {mounted ? (
        <div
          role="dialog"
          aria-label="סיווג מהיר"
          data-state={state}
          style={{ transformOrigin: 'top left' }}
          className="kf-layer kf-layer-popover absolute end-0 top-8 z-40 w-64 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700 shadow-xl"
        >
          <div className="text-xs font-semibold text-slate-600">חום</div>
          <div className="mt-1.5 grid grid-cols-4 gap-1.5">
            {HEAT_QUICK_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={chip(heat === o.value)}
                disabled={busy}
                onClick={() => {
                  onSetHeat(o.value);
                  setOpen(false);
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="mt-3 text-xs font-semibold text-slate-600">מסלול טיפול</div>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            {SEGMENT_QUICK_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={chip(segment === o.value)}
                disabled={busy}
                onClick={() => {
                  onSetSegment(o.value);
                  setOpen(false);
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
