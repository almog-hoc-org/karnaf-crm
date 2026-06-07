import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchWhatsAppRouterOptionEvents,
  fetchWhatsAppRouterOptions,
  postCreateWhatsAppRouterOption,
  postDeleteWhatsAppRouterOption,
  postUpdateWhatsAppRouterOption,
  type WhatsAppRouterOptionEvent,
  type WhatsAppRouterOption,
  type WhatsAppRouterTrack,
} from '@/lib/api';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { t } from '@/lib/i18n';

const OPTION_KEY_RE = /^[a-z][a-z0-9_]{1,59}$/;
const TRACKS: WhatsAppRouterTrack[] = ['program', 'presale', 'investor_mentorship', 'human'];

export function WhatsAppRouterOptionsPage() {
  useDocumentTitle('ראוטר WhatsApp');
  const toast = useToast();
  const qc = useQueryClient();
  const optionsQ = useQuery({ queryKey: ['whatsapp-router-options'], queryFn: fetchWhatsAppRouterOptions });
  const eventsQ = useQuery({ queryKey: ['whatsapp-router-option-events'], queryFn: () => fetchWhatsAppRouterOptionEvents(50) });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['whatsapp-router-options'] });
    qc.invalidateQueries({ queryKey: ['whatsapp-router-option-events'] });
  };
  const create = useMutation({
    mutationFn: postCreateWhatsAppRouterOption,
    onSuccess: () => { invalidate(); toast.success('אפשרות נוספה'); },
    onError: (err) => toast.error((err as Error).message),
  });
  const update = useMutation({
    mutationFn: postUpdateWhatsAppRouterOption,
    onSuccess: invalidate,
    onError: (err) => toast.error((err as Error).message),
  });
  const del = useMutation({
    mutationFn: postDeleteWhatsAppRouterOption,
    onSuccess: () => { invalidate(); toast.success('אפשרות נמחקה'); },
    onError: (err) => toast.error((err as Error).message),
  });
  const [pendingDelete, setPendingDelete] = useState<WhatsAppRouterOption | null>(null);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">ראוטר WhatsApp</h1>
        <span className="text-sm text-slate-500">{optionsQ.data?.length ?? 0} אפשרויות</span>
      </header>
      <p className="text-sm text-slate-500">
        האפשרויות כאן קובעות את תפריט הנושא של ליד חדש בוואטסאפ ואת הניתוב למסלול/שלב. שינוי נשמר ב־DB ומשפיע בלי פריסה.
      </p>

      <CreateRouterOptionForm
        busy={create.isPending}
        onSubmit={(payload) => create.mutate(payload)}
      />

      <div className="kf-card overflow-hidden md:overflow-visible">
        <table className="kf-table kf-table-responsive">
          <thead>
            <tr>
              <th>Key</th>
              <th>תווית</th>
              <th>מילות התאמה</th>
              <th>מסלול</th>
              <th>שלב/פרויקט</th>
              <th>סדר</th>
              <th>פעיל</th>
              <th>פעולות</th>
            </tr>
          </thead>
          <tbody>
            {optionsQ.isLoading ? (
              <tr><td colSpan={8} className="p-6 text-center text-slate-500">{t('loading')}</td></tr>
            ) : optionsQ.data?.length ? (
              optionsQ.data.map((option) => (
                <tr key={option.option_key} className={option.is_active ? undefined : 'opacity-60'}>
                  <td data-primary><code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs" dir="ltr">{option.option_key}</code></td>
                  <td data-label="תווית">
                    <EditableText value={option.label_he} maxLength={120} onSave={(label_he) => update.mutate({ option_key: option.option_key, label_he })} />
                  </td>
                  <td data-label="מילות התאמה">
                    <EditableText value={option.match_terms.join(', ')} maxLength={240} onSave={(v) => update.mutate({ option_key: option.option_key, match_terms: splitTerms(v) })} />
                  </td>
                  <td data-label="מסלול">
                    <select className="kf-input text-xs" value={option.track} onChange={(e) => update.mutate({ option_key: option.option_key, track: e.target.value as WhatsAppRouterTrack })}>
                      {TRACKS.map((track) => <option key={track} value={track}>{track}</option>)}
                    </select>
                  </td>
                  <td data-label="שלב/פרויקט" className="space-y-1 text-xs">
                    <EditableText value={option.stage ?? ''} placeholder="stage" maxLength={80} onSave={(stage) => update.mutate({ option_key: option.option_key, stage: stage || null })} />
                    <EditableText value={option.presale_project ?? ''} placeholder="presale_project" maxLength={180} onSave={(presale_project) => update.mutate({ option_key: option.option_key, presale_project: presale_project || null })} />
                  </td>
                  <td data-label="סדר">
                    <input
                      className="kf-input w-20 text-xs"
                      type="number"
                      min={0}
                      max={9999}
                      defaultValue={option.display_order}
                      onBlur={(e) => {
                        const display_order = Number(e.target.value);
                        if (Number.isFinite(display_order) && display_order !== option.display_order) update.mutate({ option_key: option.option_key, display_order });
                      }}
                    />
                  </td>
                  <td data-label="פעיל">
                    <label className="inline-flex items-center gap-2 text-xs">
                      <input type="checkbox" checked={option.is_active} onChange={(e) => update.mutate({ option_key: option.option_key, is_active: e.target.checked })} />
                      <span>{option.is_active ? 'פעיל' : 'כבוי'}</span>
                    </label>
                  </td>
                  <td data-actions>
                    <button type="button" className="kf-btn kf-btn-danger text-xs" onClick={() => setPendingDelete(option)}>מחיקה</button>
                  </td>
                </tr>
              ))
            ) : (
              <tr><td colSpan={8} className="p-10 text-center text-slate-500">אין אפשרויות.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        title={`מחיקת אפשרות — ${pendingDelete?.option_key ?? ''}`}
        description="מחיקה תשפיע על תפריט הוואטסאפ הבא. אם יש ספק, עדיף לכבות באמצעות 'פעיל'."
        destructive
        confirmLabel="מחיקה"
        busy={del.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          del.mutate(pendingDelete.option_key);
          setPendingDelete(null);
        }}
      />

      <RouterOptionAuditLog events={eventsQ.data ?? []} loading={eventsQ.isLoading} />
    </div>
  );
}

function RouterOptionAuditLog({ events, loading }: { events: WhatsAppRouterOptionEvent[]; loading: boolean }) {
  return (
    <section className="kf-card overflow-hidden p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">יומן שינויים</h2>
          <p className="text-sm text-slate-500">50 השינויים האחרונים באפשרויות הראוטר.</p>
        </div>
        <span className="text-xs text-slate-400">Audit</span>
      </div>
      {loading ? (
        <div className="rounded-lg border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">{t('loading')}</div>
      ) : events.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">עוד אין שינויי ראוטר מתועדים.</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {events.map((event) => (
            <li key={event.id} className="py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${event.action === 'delete' ? 'bg-rose-50 text-rose-700' : event.action === 'create' ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}>
                    {actionLabel(event.action)}
                  </span>
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs" dir="ltr">{event.option_key ?? 'unknown'}</code>
                  {event.changed_fields.length ? <span className="text-xs text-slate-500">{event.changed_fields.join(', ')}</span> : null}
                </div>
                <time className="text-xs text-slate-400" dateTime={event.created_at}>{formatDateTime(event.created_at)}</time>
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {summariseOption(event.after_value ?? event.before_value)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function actionLabel(action: WhatsAppRouterOptionEvent['action']) {
  if (action === 'create') return 'יצירה';
  if (action === 'delete') return 'מחיקה';
  return 'עדכון';
}

function summariseOption(option: Partial<WhatsAppRouterOption> | null) {
  if (!option) return 'אין פרטים זמינים';
  const label = option.label_he ? `“${option.label_he}”` : '';
  const route = [option.track, option.stage, option.presale_project].filter(Boolean).join(' / ');
  return [label, route].filter(Boolean).join(' · ') || 'אין פרטים זמינים';
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('he-IL', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function CreateRouterOptionForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (payload: Parameters<typeof postCreateWhatsAppRouterOption>[0]) => void;
}) {
  const [optionKey, setOptionKey] = useState('');
  const [label, setLabel] = useState('');
  const [terms, setTerms] = useState('');
  const [track, setTrack] = useState<WhatsAppRouterTrack>('program');
  const [stage, setStage] = useState('new');
  const [order, setOrder] = useState('100');
  const keyError = optionKey && !OPTION_KEY_RE.test(optionKey) ? 'אותיות קטנות, ספרות וקווים תחתונים בלבד (2-60 תווים, מתחיל באות)' : '';

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!optionKey || keyError || !label.trim() || splitTerms(terms).length === 0) return;
    onSubmit({
      option_key: optionKey,
      display_order: Number(order) || 100,
      label_he: label.trim(),
      match_terms: splitTerms(terms),
      track,
      stage: track === 'human' ? null : (stage.trim() || 'new'),
      interest_topic: label.trim(),
      is_active: true,
    });
    setOptionKey('');
    setLabel('');
    setTerms('');
    setTrack('program');
    setStage('new');
    setOrder('100');
  }

  return (
    <form onSubmit={submit} className="kf-card grid grid-cols-1 gap-3 p-4 lg:grid-cols-6">
      <label className="text-sm">
        <span className="text-slate-600">Key</span>
        <input className="kf-input mt-1 ltr" dir="ltr" value={optionKey} onChange={(e) => setOptionKey(e.target.value.toLowerCase())} placeholder="presale_project_x" />
        {keyError ? <span className="mt-1 block text-xs text-rose-600">{keyError}</span> : null}
      </label>
      <label className="text-sm lg:col-span-2">
        <span className="text-slate-600">תווית לנציג/לקוח</span>
        <input className="kf-input mt-1" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="פריסייל — פרויקט X" />
      </label>
      <label className="text-sm lg:col-span-2">
        <span className="text-slate-600">מילות התאמה</span>
        <input className="kf-input mt-1" value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="2, פרויקט X, פריסייל" />
      </label>
      <label className="text-sm">
        <span className="text-slate-600">מסלול</span>
        <select className="kf-input mt-1" value={track} onChange={(e) => setTrack(e.target.value as WhatsAppRouterTrack)}>
          {TRACKS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      <label className="text-sm">
        <span className="text-slate-600">Stage</span>
        <input className="kf-input mt-1 ltr" dir="ltr" value={stage} onChange={(e) => setStage(e.target.value)} disabled={track === 'human'} />
      </label>
      <label className="text-sm">
        <span className="text-slate-600">סדר</span>
        <input className="kf-input mt-1" type="number" min={0} max={9999} value={order} onChange={(e) => setOrder(e.target.value)} />
      </label>
      <div className="flex items-end lg:col-span-4">
        <button type="submit" className="kf-btn kf-btn-primary w-full" disabled={busy || !optionKey || !!keyError || !label.trim() || splitTerms(terms).length === 0}>
          {busy ? '...' : 'הוספת אפשרות ראוטר'}
        </button>
      </div>
    </form>
  );
}

function EditableText({
  value,
  maxLength,
  placeholder,
  onSave,
}: {
  value: string;
  maxLength: number;
  placeholder?: string;
  onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <button type="button" className="block text-start text-sm text-slate-800 hover:text-brand-700" onClick={() => { setDraft(value); setEditing(true); }}>
        {value || <span className="text-xs text-slate-400">{placeholder ?? 'ריק'}</span>}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <input
        autoFocus
        className="kf-input text-xs"
        value={draft}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
          if (e.key === 'Enter') {
            onSave(draft.trim());
            setEditing(false);
          }
        }}
      />
      <button type="button" className="kf-btn kf-btn-primary text-xs" onClick={() => { onSave(draft.trim()); setEditing(false); }}>✓</button>
    </span>
  );
}

function splitTerms(value: string): string[] {
  return [...new Set(value.split(',').map((term) => term.trim()).filter(Boolean))].slice(0, 20);
}
