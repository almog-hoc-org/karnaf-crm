import { useState } from 'react';
import clsx from 'clsx';
import type { LeadHeat } from '@/lib/types';
import { HEAT_LABELS } from '@/lib/format';
import type { ConsentChannel, ProfileRow } from '@/lib/api';
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
  onSetConsent?: (channel: ConsentChannel, value: boolean) => void;
}

const HEATS: LeadHeat[] = ['hot', 'warm', 'cool', 'cold'];

// "channel:value" so one select covers both flags in both directions.
const CONSENT_CHOICES: Array<{ value: string; label: string }> = [
  { value: 'email:true', label: 'מייל — כן' },
  { value: 'email:false', label: 'מייל — לא' },
  { value: 'whatsapp:true', label: 'WhatsApp — כן' },
  { value: 'whatsapp:false', label: 'WhatsApp — לא' },
];

export function BulkActionBar({
  selectedCount, totalCount, assignableUsers, busy,
  onClear, onAssignOwner, onChangeHeat, onSnooze, onSetConsent,
}: BulkActionBarProps) {
  const [mode, setMode] = useState<'idle' | 'assign' | 'heat' | 'consent'>('idle');
  const [assignee, setAssignee] = useState<string>('');
  const [heat, setHeat] = useState<LeadHeat>('warm');
  const [consentChoice, setConsentChoice] = useState<string>('email:true');
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
          {onSetConsent ? (
            <button
              type="button"
              className="kf-pressable rounded-md bg-white/10 px-3 py-1.5 transition hover:bg-white/20"
              onClick={() => setMode('consent')}
              disabled={busy}
            >
              הסכמת דיוור
            </button>
          ) : null}
        </>
      ) : null}

      {mode === 'consent' && onSetConsent ? (
        <>
          <select
            aria-label="בחר הסכמת דיוור"
            className="rounded-md bg-white/10 px-2 py-1.5 text-white"
            value={consentChoice}
            onChange={(e) => setConsentChoice(e.target.value)}
          >
            {CONSENT_CHOICES.map((c) => (
              <option key={c.value} value={c.value} className="text-slate-900">
                {c.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="kf-pressable rounded-md bg-emerald-500 px-3 py-1.5 font-semibold transition hover:bg-emerald-400 disabled:opacity-50"
            disabled={busy}
            onClick={() => {
              const [channel, value] = consentChoice.split(':');
              onSetConsent(channel as ConsentChannel, value === 'true');
              setMode('idle');
            }}
          >
            {busy ? '...' : 'עדכן'}
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
