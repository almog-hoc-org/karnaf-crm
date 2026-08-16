import {
  useCallback, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import clsx from 'clsx';
import { ToastContext, type ToastApi, type ToastInput, type ToastTone } from './toast-context';
import { usePresence } from '@/lib/usePresence';

// eslint-disable-next-line react-refresh/only-export-components
export { useToast } from './toast-context';
export type { ToastApi, ToastInput, ToastTone } from './toast-context';

interface ToastItem extends Required<ToastInput> {
  id: number;
  /** Flipped before removal so the item can play its exit. */
  leaving?: boolean;
}

const TOAST_EXIT_MS = 150;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  // Two-step removal: mark leaving so the row can fade and collapse its
  // height (neighbours flow up instead of snapping), then drop it.
  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    window.setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_EXIT_MS);
  }, []);

  const push = useCallback((input: ToastInput) => {
    const id = ++idRef.current;
    const item: ToastItem = {
      id,
      message: input.message,
      tone: input.tone ?? 'info',
      durationMs: input.durationMs ?? 4500,
    };
    setItems((prev) => [...prev, item]);
    if (item.durationMs > 0) {
      window.setTimeout(() => dismiss(id), item.durationMs);
    }
  }, [dismiss]);

  const api = useMemo<ToastApi>(() => ({
    push,
    success: (message) => push({ message, tone: 'success' }),
    error: (message) => push({ message, tone: 'error' }),
    info: (message) => push({ message, tone: 'info' }),
  }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Above dialogs (z-50): a toast confirming an action taken inside a
          modal must not render behind it. */}
      <div
        aria-live="polite" aria-atomic="false"
        className="pointer-events-none fixed top-4 left-1/2 z-[60] flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2"
      >
        {items.map((t) => (
          <ToastRow key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastRow({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const { state } = usePresence(!item.leaving, { exitMs: TOAST_EXIT_MS });
  return (
    <div className="kf-collapse" data-state={state}>
      <div>
        <div
          role="status"
          data-state={state}
          className={clsx(
            'kf-toast',
            item.tone === 'success' && 'kf-toast-success',
            item.tone === 'error' && 'kf-toast-error',
            item.tone === 'info' && 'kf-toast-info',
          )}
        >
          <ToneIcon tone={item.tone} />
          <div className="flex-1 leading-snug">{item.message}</div>
          <button
            type="button" aria-label="סגירת התראה"
            className="kf-pressable text-slate-500 transition hover:text-slate-900"
            onClick={() => onDismiss(item.id)}
          >×</button>
        </div>
      </div>
    </div>
  );
}

function ToneIcon({ tone }: { tone: ToastTone }) {
  if (tone === 'success') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-5 w-5 text-emerald-600">
        <path fill="currentColor" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7 7a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4L9 11.6l6.3-6.3a1 1 0 0 1 1.4 0z" />
      </svg>
    );
  }
  if (tone === 'error') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-5 w-5 text-rose-600">
        <path fill="currentColor" d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm-1 11h2v2H9v-2Zm0-8h2v6H9V5Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-5 w-5 text-sky-600">
      <path fill="currentColor" d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm-1 5h2v2H9V7Zm0 4h2v5H9v-5Z" />
    </svg>
  );
}
