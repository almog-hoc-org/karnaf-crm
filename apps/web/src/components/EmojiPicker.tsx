import { useEffect, useRef, useState } from 'react';
import { usePresence } from '@/lib/usePresence';

// Hand-rolled emoji grid (house style: zero UI dependencies). Popover
// shell mirrors RoleHelp/SnoozePopover: outside-click + Escape close.
// The set is curated for Hebrew real-estate sales chat.
const EMOJI_GROUPS: Array<{ label: string; emojis: string[] }> = [
  { label: 'רגשות', emojis: ['😊', '😄', '🙂', '😉', '🤗', '😅', '🥳', '😍'] },
  { label: 'אישורים', emojis: ['👍', '🙏', '💪', '👏', '🤝', '✅', '✔️', '🎉'] },
  { label: 'נדל"ן וכסף', emojis: ['🏠', '🏡', '🏢', '🗝️', '🔑', '📈', '💰', '🦏'] },
  { label: 'כללי', emojis: ['📞', '📅', '⏰', '✍️', '📋', '❤️', '🔥', '⭐'] },
];

export function EmojiPicker({ onPick, disabled }: { onPick: (emoji: string) => void; disabled?: boolean }) {
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

  return (
    <div className="relative inline-block" ref={containerRef}>
      <button
        type="button"
        className="kf-btn kf-btn-ghost px-2 text-base"
        aria-label="הוספת אימוג'י"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        😀
      </button>
      {mounted ? (
        <div
          role="dialog"
          aria-label="בחירת אימוג'י"
          data-state={state}
          // Panel sits above the button, so it grows from its bottom edge.
          style={{ transformOrigin: 'bottom left' }}
          className="kf-layer kf-layer-popover absolute bottom-10 end-0 z-40 w-64 rounded-lg border border-slate-200 bg-white p-2.5 shadow-xl"
        >
          {EMOJI_GROUPS.map((group) => (
            <div key={group.label} className="mb-1.5 last:mb-0">
              <div className="mb-0.5 text-[10px] font-semibold text-slate-400">{group.label}</div>
              <div className="grid grid-cols-8 gap-0.5">
                {group.emojis.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="kf-pressable grid h-7 w-7 place-items-center rounded text-base transition hover:bg-brand-50"
                    onClick={() => onPick(emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
