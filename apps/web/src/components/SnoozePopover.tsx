import { useEffect, useRef, useState } from 'react';
import { usePresence } from '@/lib/usePresence';
import {
  SNOOZE_PRESETS,
  computeSnoozeUntil,
  snoozeUntilFromDate,
  type SnoozePreset,
} from '@lib/view-models/snooze';

// "לבדוק שוב בעוד X" — the operator snooze picker. Popover shell follows
// RoleHelp (outside-click + Escape + absolute panel). The chosen expiry
// is morning-anchored by the shared snooze view-model, so a "בעוד שבוע"
// lead pops back at the start of the working day.
export function SnoozePopover({
  onSnooze,
  busy,
  buttonClassName,
  label = 'השהיה ⏰',
}: {
  onSnooze: (snoozeUntilIso: string, note: string | null) => void;
  busy?: boolean;
  buttonClassName?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [customDate, setCustomDate] = useState('');
  const [note, setNote] = useState('');
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

  function pick(preset: SnoozePreset) {
    onSnooze(computeSnoozeUntil(preset, Date.now()), note.trim() || null);
    setOpen(false);
    setNote('');
    setCustomDate('');
  }

  function pickCustom() {
    const iso = snoozeUntilFromDate(customDate);
    if (!iso) return;
    onSnooze(iso, note.trim() || null);
    setOpen(false);
    setNote('');
    setCustomDate('');
  }

  const today = new Date().toISOString().slice(0, 10);

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
          aria-label="בחירת מועד לבדיקה חוזרת"
          data-state={state}
          // Grows from the button that opened it (panel hangs below-end,
          // so the origin is that corner) and shrinks back into it.
          style={{ transformOrigin: 'top left' }}
          className="kf-layer kf-layer-popover absolute end-0 top-8 z-40 w-64 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700 shadow-xl"
        >
          <div className="text-xs font-semibold text-slate-600">לבדוק שוב בעוד:</div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {SNOOZE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                className="kf-pressable rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs transition hover:bg-brand-50 hover:text-brand-700"
                onClick={() => pick(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <input
              type="date"
              className="kf-input flex-1 text-xs"
              min={today}
              value={customDate}
              onChange={(e) => setCustomDate(e.target.value)}
              aria-label="תאריך אחר"
            />
            <button
              type="button"
              className="kf-btn kf-btn-ghost text-xs"
              disabled={!snoozeUntilFromDate(customDate)}
              onClick={pickCustom}
            >
              קבע
            </button>
          </div>
          <input
            className="kf-input mt-2 w-full text-xs"
            placeholder="הערה (מה לבדוק?) — אופציונלי"
            maxLength={280}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="mt-2 text-[11px] leading-4 text-slate-400">
            ההשהיה מוסרת אוטומטית אם הלקוח כותב, והליד יקפוץ חזרה לתור במועד שנבחר.
          </p>
        </div>
      ) : null}
    </div>
  );
}
