import type { ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-slate-500">
      {icon ? <span aria-hidden="true" className="text-3xl opacity-70">{icon}</span> : null}
      <p className="font-medium text-slate-600">{title}</p>
      {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}
