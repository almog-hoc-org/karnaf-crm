import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchProjects, postProjectAction } from '@/lib/api';
import type { ProjectFundingRow, ProjectRow, ProjectStatus, ProjectType } from '@/lib/types';
import { useToast } from '@/components/Toast';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { t } from '@/lib/i18n';

const TYPE_LABELS: Record<ProjectType, string> = {
  residential: 'מגורים',
  commercial: 'מסחרי',
  mixed: 'משולב',
};

const STATUS_LABELS: Record<ProjectStatus, string> = {
  recruiting: 'בגיוס',
  closed: 'סגור לגיוס',
  executed: 'נסגר ובוצע',
  cancelled: 'בוטל',
};

export function ProjectsPage() {
  useDocumentTitle('פרויקטי פריסייל');
  const toast = useToast();
  const qc = useQueryClient();

  const projectsQ = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });

  const action = useMutation({
    mutationFn: postProjectAction,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      toast.success('עודכן');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const projects = projectsQ.data?.projects ?? [];
  const fundingById = useMemo(() => {
    const m = new Map<string, ProjectFundingRow>();
    for (const f of projectsQ.data?.funding ?? []) m.set(f.project_id, f);
    return m;
  }, [projectsQ.data?.funding]);

  const [editing, setEditing] = useState<ProjectRow | null>(null);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">פרויקטי פריסייל</h1>
        <span className="text-sm text-slate-500">{projects.length} פרויקטים</span>
      </header>

      <p className="text-sm text-slate-500">
        כל פרויקט פריסייל אוסף הרשמות עד שמגיע ליעד הגיוס. אחוזי הגיוס מחושבים
        אוטומטית מהעסקאות הפתוחות והסגורות. סטטוס בגיוס → סגור → בוצע.
      </p>

      <CreateForm onSubmit={(payload) => action.mutate(payload)} busy={action.isPending} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {projectsQ.isLoading ? (
          <p className="text-slate-500">{t('loading')}</p>
        ) : projects.length === 0 ? (
          <p className="text-slate-500">אין פרויקטים פעילים.</p>
        ) : projects.map((p) => {
          const f = fundingById.get(p.id);
          const pct = f?.funding_pct ?? null;
          const committedAmount = f?.committed_amount ?? 0;
          return (
            <article key={p.id} className="kf-card flex flex-col gap-2 p-4">
              <header className="flex items-baseline justify-between gap-2">
                <h2 className="text-base font-semibold">{p.name}</h2>
                <span className="text-xs text-slate-500">{STATUS_LABELS[p.status] ?? p.status}</span>
              </header>
              <div className="text-sm text-slate-600">
                {p.city ? `${p.city}` : ''}
                {p.developer_name ? ` · ${p.developer_name}` : ''}
                {p.project_type ? ` · ${TYPE_LABELS[p.project_type]}` : ''}
              </div>
              {p.target_amount ? (
                <div>
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>גויס {committedAmount.toLocaleString('he-IL')} {p.currency}</span>
                    <span>יעד {p.target_amount.toLocaleString('he-IL')}</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={pct !== null && pct >= 100 ? 'h-full bg-emerald-500' : 'h-full bg-brand-500'}
                      style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
                    />
                  </div>
                  {pct !== null ? <div className="mt-1 text-xs text-slate-500">{pct}% מהיעד</div> : null}
                </div>
              ) : null}
              {p.total_units ? (
                <div className="text-xs text-slate-500">
                  יחידות: {f?.committed_units ?? 0} / {p.total_units}
                  {p.price_per_unit ? ` · ${p.price_per_unit.toLocaleString('he-IL')} ${p.currency} ליחידה` : ''}
                </div>
              ) : null}
              {p.target_date ? <div className="text-xs text-slate-500">תאריך יעד: {p.target_date}</div> : null}
              <div className="flex flex-wrap gap-1 pt-2">
                <button type="button" className="kf-btn text-xs" onClick={() => setEditing(p)}>עריכה</button>
                {p.status === 'recruiting' ? (
                  <button type="button" className="kf-btn kf-btn-primary text-xs" disabled={action.isPending}
                    onClick={() => {
                      if (window.confirm(`לשלוח הצעת פריסייל (C14) לכל הלידים המתאימים לפרויקט ${p.name}? פעולה אינה הפיכה — ההודעות נכנסות מיד לתור.`)) {
                        action.mutate({ action: 'publish', id: p.id });
                      }
                    }}
                    title="שולח C14 לכל הלידים שמתעניינים בפריסייל / קבוצת רכישה">פרסום ללידים</button>
                ) : null}
                {p.status === 'recruiting' ? (
                  <button type="button" className="kf-btn text-xs" disabled={action.isPending}
                    onClick={() => action.mutate({ action: 'close', id: p.id })}>סגירה לגיוס</button>
                ) : null}
                {p.status === 'closed' ? (
                  <button type="button" className="kf-btn text-xs" disabled={action.isPending}
                    onClick={() => action.mutate({ action: 'mark_executed', id: p.id })}>סימון בוצע</button>
                ) : null}
                {(p.status === 'closed' || p.status === 'cancelled') ? (
                  <button type="button" className="kf-btn text-xs" disabled={action.isPending}
                    onClick={() => action.mutate({ action: 'reopen', id: p.id })}>פתיחה מחדש</button>
                ) : null}
                {p.status !== 'cancelled' && p.status !== 'executed' ? (
                  <button type="button" className="kf-btn text-xs" disabled={action.isPending}
                    onClick={() => action.mutate({ action: 'cancel', id: p.id })}>ביטול</button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      {editing ? (
        <EditDialog
          project={editing}
          busy={action.isPending}
          onSubmit={(patch) => {
            action.mutate({ action: 'update', id: editing.id, ...patch });
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function CreateForm({
  onSubmit,
  busy,
}: {
  onSubmit: (payload: { action: 'create'; name: string; city?: string; developer_name?: string;
    project_type?: ProjectType; total_units?: number; price_per_unit?: number;
    target_amount?: number; target_date?: string }) => void;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [developer, setDeveloper] = useState('');
  const [type, setType] = useState<ProjectType>('residential');
  const [units, setUnits] = useState('');
  const [pricePerUnit, setPricePerUnit] = useState('');
  const [target, setTarget] = useState('');

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({
      action: 'create',
      name: name.trim(),
      city: city.trim() || undefined,
      developer_name: developer.trim() || undefined,
      project_type: type,
      total_units: units ? Number(units) : undefined,
      price_per_unit: pricePerUnit ? Number(pricePerUnit) : undefined,
      target_amount: target ? Number(target) : undefined,
    });
    setName(''); setCity(''); setDeveloper(''); setUnits(''); setPricePerUnit(''); setTarget('');
  }

  return (
    <form onSubmit={submit} className="kf-card grid grid-cols-1 gap-3 p-4 sm:grid-cols-4">
      <input className="kf-input sm:col-span-2" placeholder="שם פרויקט" required
        value={name} onChange={(e) => setName(e.target.value)} />
      <input className="kf-input" placeholder="עיר" value={city} onChange={(e) => setCity(e.target.value)} />
      <input className="kf-input" placeholder="יזם" value={developer} onChange={(e) => setDeveloper(e.target.value)} />
      <select className="kf-input" value={type} onChange={(e) => setType(e.target.value as ProjectType)}>
        {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <input className="kf-input" type="number" min={0} placeholder="מספר יחידות"
        value={units} onChange={(e) => setUnits(e.target.value)} />
      <input className="kf-input" type="number" min={0} placeholder="מחיר ליחידה"
        value={pricePerUnit} onChange={(e) => setPricePerUnit(e.target.value)} />
      <div className="flex gap-2">
        <input className="kf-input flex-1" type="number" min={0} placeholder="יעד גיוס"
          value={target} onChange={(e) => setTarget(e.target.value)} />
        <button type="submit" className="kf-btn kf-btn-primary text-sm" disabled={busy}>
          {busy ? 'מוסיף...' : 'הוסף פרויקט'}
        </button>
      </div>
    </form>
  );
}

function EditDialog({
  project,
  busy,
  onSubmit,
  onCancel,
}: {
  project: ProjectRow;
  busy: boolean;
  onSubmit: (patch: Partial<Omit<ProjectRow, 'id' | 'status' | 'metadata' | 'created_at' | 'updated_at' | 'currency'>>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [city, setCity] = useState(project.city ?? '');
  const [developer, setDeveloper] = useState(project.developer_name ?? '');
  const [type, setType] = useState<ProjectType>(project.project_type);
  const [units, setUnits] = useState(project.total_units?.toString() ?? '');
  const [pricePerUnit, setPricePerUnit] = useState(project.price_per_unit?.toString() ?? '');
  const [target, setTarget] = useState(project.target_amount?.toString() ?? '');
  const [targetDate, setTargetDate] = useState(project.target_date ?? '');
  const [notes, setNotes] = useState(project.notes ?? '');

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSubmit({
      name: name.trim(),
      city: city.trim() || null,
      developer_name: developer.trim() || null,
      project_type: type,
      total_units: units ? Number(units) : null,
      price_per_unit: pricePerUnit ? Number(pricePerUnit) : null,
      target_amount: target ? Number(target) : null,
      target_date: targetDate || null,
      notes: notes.trim() || null,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <form className="kf-card max-h-[90vh] w-full max-w-2xl space-y-3 overflow-auto p-5" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">עריכת פרויקט</h2>
        <label className="block text-sm">
          <span className="text-slate-600">שם</span>
          <input className="kf-input mt-1" required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="text-slate-600">עיר</span>
            <input className="kf-input mt-1" value={city} onChange={(e) => setCity(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">יזם</span>
            <input className="kf-input mt-1" value={developer} onChange={(e) => setDeveloper(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">סוג</span>
            <select className="kf-input mt-1" value={type} onChange={(e) => setType(e.target.value as ProjectType)}>
              {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">תאריך יעד</span>
            <input className="kf-input mt-1" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">יחידות סה"כ</span>
            <input className="kf-input mt-1" type="number" min={0} value={units} onChange={(e) => setUnits(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">מחיר ליחידה</span>
            <input className="kf-input mt-1" type="number" min={0} value={pricePerUnit} onChange={(e) => setPricePerUnit(e.target.value)} />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-600">יעד גיוס סופי</span>
            <input className="kf-input mt-1" type="number" min={0} value={target} onChange={(e) => setTarget(e.target.value)} />
          </label>
        </div>
        <label className="block text-sm">
          <span className="text-slate-600">הערות</span>
          <textarea className="kf-input mt-1 min-h-[60px]" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="kf-btn" onClick={onCancel}>ביטול</button>
          <button type="submit" className="kf-btn kf-btn-primary" disabled={busy}>{busy ? 'שומר...' : 'שמירה'}</button>
        </div>
      </form>
    </div>
  );
}
