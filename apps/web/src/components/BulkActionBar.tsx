import { useState } from 'react';
import clsx from 'clsx';
import type { LeadHeat } from '@/lib/types';
import { HEAT_LABELS } from '@/lib/format';
import type { ProfileRow } from '@/lib/api';
import { SnoozePopover } from '@/components/SnoozePopover';
import { usePresence } from '@/lib/usePresence';

export interface BulkActionBarProps {
  selectedCount: number;
  totalCount: number;
  assignableUsers: ProfileRow[];
  busy: boolean;
  onClear: () => void;
  onAssignOwner: (userId: string) => void;
  onChangeHeat: (heat: LeadHeat) => void;
  onSnooze?: (snoozeUntilIso: string, note: string | null) => void;
}

const HEATS: LeadHeat[] = ['hot', 'warm', 'cool', 'cold'];

export function BulkActionBar({
  selectedCount, totalCount, assignableUsers, busy,
  onClear, onAssignOwner, onChangeHeat, onSnooze,
}: BulkActionBarProps) {
  const [mode, setMode] = useState<'idle' | 'assign' | 'heat'>('idle');
  const [assignee, setAssignee] = useState<string>('');
  const [heat, setHeat] = useState<LeadHeat>('warm');
  // The dock rises when the first row is ticked and leaves the same way,
  // so selecting/deselecting reads as one continuous object.
  const { mounted, state } = usePresence(selectedCount > 0);

  if (!mounted) return null;

  return (
    <div
      role="region"
      aria-label="פעולות מרובות"
      data-state={state}
      className={clsx(
        'kf-layer kf-layer-dock sticky bottom-3 z-20 mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-xl',
        'bg-slate-900 px-4 py-3 text-sm text-white shadow-xl ring-1 ring-slate-700',
      )}
    >
      <span className="font-semibold tabular-nums">
        נבחרו {selectedCount}{totalCount ? ` / ${totalCount}` : ''}
      </span>

      {mode === 'idle' ? (
        <>
          <button
            type="button"
            className="kf-pressable rounded-md bg-white/10 px-3 py-1.5 transition hover:bg-white/20"
            onClick={() => setMode('assign')}
            disabled={busy}
          >
            שיוך למשתמש
          </button>
          <button
            type="button"
            className="kf-pressable rounded-md bg-white/10 px-3 py-1.5 transition hover:bg-white/20"
            onClick={() => setMode('heat')}
            disabled={busy}
          >
            שינוי דרגת חום
          </button>
          {onSnooze ? (
            <SnoozePopover
              buttonClassName="kf-pressable rounded-md bg-white/10 px-3 py-1.5 text-white transition hover:bg-white/20"
              busy={busy}
              onSnooze={onSnooze}
            />
          ) : null}
        </>
      ) : null}

      {mode === 'assign' ? (
        <>
          <select
            aria-label="בחר משתמש"
            className="rounded-md bg-white/10 px-2 py-1.5 text-white"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">— בחר —</option>
            {assignableUsers.map((u) => (
              <option key={u.id} value={u.id} className="text-slate-900">
                {u.full_name || u.email || u.id.slice(0, 8)} ({u.role})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="kf-pressable rounded-md bg-emerald-500 px-3 py-1.5 font-semibold transition hover:bg-emerald-400 disabled:opacity-50"
            disabled={!assignee || busy}
            onClick={() => {
              onAssignOwner(assignee);
              setMode('idle');
              setAssignee('');
            }}
          >
            {busy ? '...' : 'שייך'}
          </button>
          <button
            type="button"
            className="kf-pressable rounded-md bg-white/10 px-3 py-1.5 transition hover:bg-white/20"
            onClick={() => { setMode('idle'); setAssignee(''); }}
          >
            ביטול
          </button>
        </>
      ) : null}

      {mode === 'heat' ? (
        <>
          <select
            aria-label="בחר דרגת חום"
            className="rounded-md bg-white/10 px-2 py-1.5 text-white"
            value={heat}
            onChange={(e) => setHeat(e.target.value as LeadHeat)}
          >
            {HEATS.map((h) => (
              <option key={h} value={h} className="text-slate-900">
                {HEAT_LABELS[h]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="kf-pressable rounded-md bg-emerald-500 px-3 py-1.5 font-semibold transition hover:bg-emerald-400 disabled:opacity-50"
            disabled={busy}
            onClick={() => {
              onChangeHeat(heat);
              setMode('idle');
            }}
          >
            {busy ? '...' : 'שנה'}
          </button>
          <button
            type="button"
            className="kf-pressable rounded-md bg-white/10 px-3 py-1.5 transition hover:bg-white/20"
            onClick={() => setMode('idle')}
          >
            ביטול
          </button>
        </>
      ) : null}

      <button
        type="button"
        className="kf-pressable ms-auto rounded-md bg-transparent px-2 py-1.5 text-white/70 transition hover:text-white"
        onClick={() => { setMode('idle'); onClear(); }}
        aria-label="ניקוי בחירה"
      >
        ×
      </button>
    </div>
  );
}
