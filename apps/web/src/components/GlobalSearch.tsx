import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { fetchLeadsList } from '@/lib/api';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { formatRelative } from '@/lib/format';
import { Modal } from '@/components/Modal';

// "Find a customer" from anywhere: the header button or Ctrl/⌘+K. Finding
// someone used to mean leaving the current screen for the leads list and
// its nineteen filters. Name, phone or email; Enter opens the first hit.
export function GlobalSearch() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // event.code, not key: works on the Hebrew layout too.
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
        e.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <button
        type="button"
        className="kf-btn kf-btn-ghost gap-2 text-slate-500"
        onClick={() => setOpen(true)}
        aria-label="חיפוש לקוח"
        title="חיפוש לקוח (Ctrl+K)"
      >
        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="9" cy="9" r="5.5" /><path strokeLinecap="round" d="m13.5 13.5 3.5 3.5" />
        </svg>
        <span className="hidden lg:inline">חיפוש</span>
        <kbd className="hidden rounded border border-slate-200 px-1 text-[10px] text-slate-400 lg:inline">Ctrl K</kbd>
      </button>
      {open ? <SearchDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const debounced = useDebouncedValue(term.trim(), 250);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const q = useQuery({
    queryKey: ['global-search', debounced],
    queryFn: () => fetchLeadsList({ search: debounced, limit: 8 }),
    enabled: debounced.length >= 2,
    staleTime: 30_000,
  });
  const results = debounced.length >= 2 ? q.data?.leads ?? [] : [];

  function openLead(id: string) {
    onClose();
    navigate(`/leads/${id}`);
  }

  return (
    <Modal title="חיפוש לקוח" onClose={onClose} size="lg">
      <input
        ref={inputRef}
        type="search"
        className="kf-input w-full"
        placeholder="שם, טלפון או מייל"
        aria-label="חיפוש לפי שם, טלפון או מייל"
        value={term}
        onChange={(e) => { setTerm(e.target.value); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0))); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
          if (e.key === 'Enter' && results[active]) { e.preventDefault(); openLead(results[active].id); }
        }}
      />
      <div className="mt-3 min-h-[3rem]" aria-live="polite">
        {debounced.length < 2 ? (
          <p className="text-sm text-slate-500">הקלידו לפחות שני תווים.</p>
        ) : q.isLoading ? (
          <p className="text-sm text-slate-500">מחפש...</p>
        ) : q.error ? (
          <p className="text-sm text-rose-600">החיפוש נכשל: {(q.error as Error).message}</p>
        ) : results.length === 0 ? (
          <p className="text-sm text-slate-500">לא נמצא לקוח תואם.</p>
        ) : (
          <ul className="divide-y divide-slate-100" role="listbox" aria-label="תוצאות חיפוש">
            {results.map((lead, i) => (
              <li key={lead.id} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  className={clsx(
                    'flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-2 text-start transition',
                    i === active ? 'bg-brand-50' : 'hover:bg-slate-50',
                  )}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => openLead(lead.id)}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-slate-900">{lead.full_name || 'ללא שם'}</span>
                    <span className="block truncate text-xs text-slate-500">
                      {[lead.phone, lead.email].filter(Boolean).join(' · ') || '—'}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">{formatRelative(lead.updated_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
