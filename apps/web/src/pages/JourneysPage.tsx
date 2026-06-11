import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { fetchJourneys, postCancelJourneyRun, postUpdateJourneyDef } from '@/lib/api';
import type { JourneyDefinitionRow, JourneyRunStatus, JourneyStepDef } from '@/lib/types';
import { useToast } from '@/components/Toast';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { PageIntro } from '@/components/PageIntro';
import { JOURNEY_RUN_STATUS_LABELS, formatRelative } from '@/lib/format';
import { t } from '@/lib/i18n';

// Tier 7.C.1 — central labels.
const STATUS_LABELS = JOURNEY_RUN_STATUS_LABELS as Record<JourneyRunStatus, string>;

const STATUS_TONE: Record<JourneyRunStatus, string> = {
  active: 'text-sky-700',
  completed: 'text-emerald-700',
  cancelled: 'text-slate-500',
  failed: 'text-rose-700',
};

export function JourneysPage() {
  useDocumentTitle('מסעות לקוח');
  const toast = useToast();
  const qc = useQueryClient();

  const q = useQuery({ queryKey: ['journeys'], queryFn: () => fetchJourneys(true) });

  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => postCancelJourneyRun(id, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['journeys'] });
      toast.success('הריצה בוטלה');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const updateDef = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof postUpdateJourneyDef>[1] }) =>
      postUpdateJourneyDef(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['journeys'] });
      toast.success('מסע עודכן');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const definitions = q.data?.definitions ?? [];
  const counts = q.data?.counts ?? {};
  const runs = q.data?.runs ?? [];

  // Overall headline counts across all definitions.
  const totalsByStatus = useMemo(() => {
    const acc: Record<JourneyRunStatus, number> = { active: 0, completed: 0, cancelled: 0, failed: 0 };
    for (const r of q.data?.runs ?? []) acc[r.status]++;
    return acc;
  }, [q.data?.runs]);

  const [editing, setEditing] = useState<JourneyDefinitionRow | null>(null);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">מסעות לקוח</h1>
        <span className="text-sm text-slate-500">{definitions.length} מסעות מוגדרים</span>
      </header>

      <PageIntro>
        כל מסע הוא רצף שלבים שמתקדם אוטומטית לכל איש קשר שנכנס אליו. שלב מורכב
        מ-actions (פעולות) + delay_hours (השהיה מהשלב הקודם). אפשר לערוך את
        השלבים כ-JSON ולראות באיזה שלב כל ריצה. ה-cron tick מתקדם ריצות שמועד
        ה-scheduled_next_at שלהן הגיע.
      </PageIntro>

      <section className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {(['active', 'completed', 'cancelled', 'failed'] as JourneyRunStatus[]).map((s) => (
          <div key={s} className="kf-card p-3">
            <div className="text-xs text-slate-500">{STATUS_LABELS[s]}</div>
            <div className={clsx('mt-1 text-2xl font-semibold tabular-nums', STATUS_TONE[s])}>
              {totalsByStatus[s]}
            </div>
          </div>
        ))}
      </section>

      {q.isLoading ? <p className="text-slate-500">{t('loading')}</p> : null}

      <section className="space-y-3">
        {definitions.map((def) => {
          const c = counts[def.id] ?? {};
          return (
            <article key={def.id} className={clsx(
              'kf-card p-4',
              !def.enabled && 'opacity-70',
            )}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-lg font-semibold">{def.name_he}</h2>
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono text-slate-600">{def.code}</code>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className={def.enabled ? 'text-emerald-700' : 'text-slate-400'}>
                    {def.enabled ? 'פעיל' : 'מושבת'}
                  </span>
                  <button type="button" className="kf-btn text-xs" onClick={() => setEditing(def)}>
                    עריכה
                  </button>
                </div>
              </div>
              {def.description ? <p className="mt-1 text-xs text-slate-500">{def.description}</p> : null}
              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                <span>טריגר: <code className="font-mono">{def.trigger_event}</code></span>
                <span>{def.steps.length} שלבים</span>
                {def.allow_concurrent ? <span className="text-amber-700">ריצות מקבילות מותרות</span> : null}
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {(['active', 'completed', 'cancelled', 'failed'] as JourneyRunStatus[]).map((s) => (
                  c[s] ? (
                    <span key={s} className={clsx('rounded-full bg-slate-100 px-2 py-0.5', STATUS_TONE[s])}>
                      {STATUS_LABELS[s]}: <strong>{c[s]}</strong>
                    </span>
                  ) : null
                ))}
              </div>
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-slate-500">שלבים</summary>
                <ol className="mt-2 space-y-1 list-decimal pr-5">
                  {def.steps.map((step, i) => (
                    <li key={i}>
                      <strong>{step.name ?? `step ${i}`}</strong>
                      {step.delay_hours !== undefined ? <span className="text-slate-500"> · השהייה {step.delay_hours}ש׳</span> : null}
                      {step.actions ? <span className="text-slate-500"> · {step.actions.length} פעולות</span> : null}
                    </li>
                  ))}
                </ol>
              </details>
            </article>
          );
        })}
      </section>

      {runs.length > 0 ? (
        <section className="kf-card p-4">
          <h2 className="text-lg font-semibold">ריצות אחרונות</h2>
          <div className="mt-3 -mx-4 overflow-x-auto sm:mx-0">
            <table className="kf-table min-w-[48rem]">
              <thead>
                <tr>
                  <th>מסע</th>
                  <th>איש קשר</th>
                  <th>שלב</th>
                  <th>סטטוס</th>
                  <th>הבא ב-</th>
                  <th>פעולות</th>
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, 30).map((run) => (
                  <tr key={run.id}>
                    <td><code className="text-xs">{run.definition_code}</code></td>
                    <td><code className="text-xs text-slate-500">{run.contact_id.slice(0, 8)}</code></td>
                    <td className="tabular-nums">{run.current_step + 1}</td>
                    <td className={STATUS_TONE[run.status]}>{STATUS_LABELS[run.status]}</td>
                    <td className="text-xs text-slate-500" title={run.scheduled_next_at}>
                      {run.status === 'active' ? formatRelative(run.scheduled_next_at) : '—'}
                    </td>
                    <td>
                      {run.status === 'active' ? (
                        <button type="button" className="kf-btn text-xs" disabled={cancel.isPending}
                          onClick={() => {
                            const reason = window.prompt('סיבת ביטול?');
                            if (reason) cancel.mutate({ id: run.id, reason });
                          }}>
                          ביטול
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {editing ? (
        <EditJourneyDialog
          def={editing}
          busy={updateDef.isPending}
          onSubmit={(patch) => {
            updateDef.mutate({ id: editing.id, patch });
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function EditJourneyDialog({
  def,
  busy,
  onSubmit,
  onCancel,
}: {
  def: JourneyDefinitionRow;
  busy: boolean;
  onSubmit: (patch: Parameters<typeof postUpdateJourneyDef>[1]) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(def.name_he);
  const [description, setDescription] = useState(def.description ?? '');
  const [enabled, setEnabled] = useState(def.enabled);
  const [allowConcurrent, setAllowConcurrent] = useState(def.allow_concurrent);
  const [stepsJson, setStepsJson] = useState(() => JSON.stringify(def.steps ?? [], null, 2));
  const [triggerJson, setTriggerJson] = useState(() => JSON.stringify(def.trigger_conditions ?? {}, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setParseError(null);
    let steps: JourneyStepDef[];
    let triggerConditions: Record<string, unknown>;
    try {
      steps = JSON.parse(stepsJson);
      if (!Array.isArray(steps)) throw new Error('steps חייב להיות מערך');
    } catch (err) {
      setParseError(`steps: ${(err as Error).message}`); return;
    }
    try {
      triggerConditions = JSON.parse(triggerJson);
      if (typeof triggerConditions !== 'object' || triggerConditions === null || Array.isArray(triggerConditions)) {
        throw new Error('trigger_conditions חייב להיות אובייקט');
      }
    } catch (err) {
      setParseError(`trigger_conditions: ${(err as Error).message}`); return;
    }
    onSubmit({
      name_he: name.trim(),
      description: description.trim() || undefined,
      enabled,
      allow_concurrent: allowConcurrent,
      steps,
      trigger_conditions: triggerConditions,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <form className="kf-card max-h-[92vh] w-full max-w-3xl space-y-3 overflow-auto p-5" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <header>
          <h2 className="text-lg font-semibold">עריכת מסע — {def.name_he}</h2>
          <code className="text-xs text-slate-500">{def.code} · {def.trigger_event}</code>
        </header>
        <label className="block text-sm">
          <span className="text-slate-600">שם</span>
          <input className="kf-input mt-1" required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="text-slate-600">תיאור</span>
          <textarea className="kf-input mt-1 min-h-[60px]" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>פעיל</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={allowConcurrent} onChange={(e) => setAllowConcurrent(e.target.checked)} />
            <span>אפשר ריצות מקבילות לאותו איש קשר</span>
          </label>
        </div>
        {/* Tier 6.D.3 — JSON editing is the long-tail use case; basic
            metadata edits are 80% of dialog opens. Collapse the two
            heavy textareas behind a single disclosure. */}
        <details className="rounded-md border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">עריכת שלבים ותנאים (JSON)</summary>
          <label className="mt-3 block text-sm">
            <span className="text-slate-600">trigger_conditions (JSON)</span>
            <textarea className="kf-input mt-1 min-h-[100px] font-mono text-xs leading-5" dir="ltr"
              value={triggerJson} onChange={(e) => setTriggerJson(e.target.value)} />
          </label>
          <label className="mt-3 block text-sm">
            <span className="text-slate-600">steps (JSON array)</span>
            <textarea className="kf-input mt-1 min-h-[200px] font-mono text-xs leading-5" dir="ltr"
              value={stepsJson} onChange={(e) => setStepsJson(e.target.value)} />
          </label>
        </details>
        {parseError ? <p className="text-sm text-rose-600">{parseError}</p> : null}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="kf-btn" onClick={onCancel}>ביטול</button>
          <button type="submit" className="kf-btn kf-btn-primary" disabled={busy}>{busy ? 'שומר...' : 'שמירה'}</button>
        </div>
      </form>
    </div>
  );
}
