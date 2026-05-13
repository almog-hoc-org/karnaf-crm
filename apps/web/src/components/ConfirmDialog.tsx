import { useEffect, useId, useRef, type ReactNode } from 'react';
import { t } from '../lib/i18n';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onCancel();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
      onMouseDown={handleBackdrop}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="w-full max-w-md rounded-lg bg-white shadow-xl"
      >
        <div className="p-5">
          <h2 id={headingId} className="text-lg font-semibold text-slate-900">
            {title}
          </h2>
          {description ? <div className="mt-2 text-sm text-slate-600">{description}</div> : null}
          {children ? <div className="mt-3">{children}</div> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button type="button" className="kf-btn" onClick={onCancel} disabled={busy}>
            {cancelLabel ?? t('cancel')}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={destructive ? 'kf-btn kf-btn-danger' : 'kf-btn kf-btn-primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '...' : (confirmLabel ?? t('confirm'))}
          </button>
        </div>
      </div>
    </div>
  );
}
