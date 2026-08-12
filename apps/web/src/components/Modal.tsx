import { useEffect, useId, type ReactNode } from 'react';
import clsx from 'clsx';
import { usePresence } from '@/lib/usePresence';

export interface ModalProps {
  /** Omit for layers the parent mounts conditionally. */
  open?: boolean;
  title?: ReactNode;
  onClose: () => void;
  /**
   * A plain node gets the standard panel. A function receives the
   * presence state and renders its own panel — used by the form-shaped
   * dialogs that already carry their own layout, which then just add
   * `kf-layer kf-layer-dialog` and `data-state`.
   */
  children: ReactNode | ((state: 'open' | 'closed') => ReactNode);
  /** Tailwind max-width class for the standard panel. */
  size?: 'md' | 'lg' | 'xl' | '2xl' | '3xl';
  /** Long forms scroll the page behind the panel instead of the panel itself. */
  scrollPage?: boolean;
  className?: string;
}

const SIZE_CLASS: Record<NonNullable<ModalProps['size']>, string> = {
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
};

/**
 * The app's dialog shell. Replaces nine hand-rolled copies that each
 * mounted instantly, used their own scrim colour, and picked their own
 * radius and shadow.
 */
export function Modal({
  open = true,
  title,
  onClose,
  children,
  size = '2xl',
  scrollPage = false,
  className,
}: ModalProps) {
  const headingId = useId();
  const { mounted, state } = usePresence(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <div
      data-state={state}
      className={clsx(
        'kf-layer kf-layer-fade fixed inset-0 z-50 flex justify-center bg-slate-900/40 p-4',
        scrollPage ? 'items-start overflow-y-auto' : 'items-center',
      )}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {typeof children === 'function' ? children(state) : (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? headingId : undefined}
          data-state={state}
          className={clsx(
            'kf-layer kf-layer-dialog w-full rounded-xl bg-white p-5 shadow-xl',
            scrollPage && 'my-8',
            SIZE_CLASS[size],
            className,
          )}
        >
          {title ? (
            <div className="mb-3 flex items-start justify-between gap-3">
              <h2 id={headingId} className="text-lg font-semibold text-slate-900">{title}</h2>
              <button
                type="button"
                className="kf-pressable rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                onClick={onClose}
                aria-label="סגירה"
              >
                ✕
              </button>
            </div>
          ) : null}
          {children}
        </div>
      )}
    </div>
  );
}
