import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import {
  fetchPromptVariants, postCreatePromptVariant, postUpdatePromptVariant,
  postDeletePromptVariant,
  type PlaybookName, type PromptVariantRow,
} from '@/lib/api';
import { useAuth } from '@/auth/auth-context';
import { useToast } from '@/components/Toast';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { formatDateTime } from '@/lib/format';
import { LoadFailed } from '@/components/LoadFailed';

const PLAYBOOKS: PlaybookName[] = [
  'first_contact_whatsapp_inbound', 'first_contact_form_lead', 'qualification',
  'price_objection', 'free_advice_boundary', 'checkout_push',
  'payment_pending_rescue', 'phone_request', 'opt_out',
];

export function PromptVariantsPage() {
  const auth = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  useDocumentTitle('תבניות AI');
  const list = useQuery({ queryKey: ['prompt-variants'], queryFn: fetchPromptVariants });

  const create = useMutation({
    mutationFn: postCreatePromptVariant,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['prompt-variants'] }); toast.success('גרסה נוצרה'); },
    onError: (err) => toast.error((err as Error).message),
  });
  const update = useMutation({
    mutationFn: postUpdatePromptVariant,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['prompt-variants'] }); toast.success('גרסה עודכנה'); },
    onError: (err) => toast.error((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: postDeletePromptVariant,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['prompt-variants'] }); toast.success('גרסה נמחקה'); },
    onError: (err) => toast.error((err as Error).message),
  });

  if (auth.role !== 'owner' && auth.role !== 'admin') {
    return <Navigate to="/inbox" replace />;
  }

  const variantsByPlaybook = (list.data ?? []).reduce<Record<string, PromptVariantRow[]>>((acc, v) => {
    const bucket = acc[v.playbook_name] ?? [];
    bucket.push(v);
    acc[v.playbook_name] = bucket;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      {list.error ? (
        <LoadFailed error={list.error} onRetry={() => void list.refetch()} hint="זו תקלת טעינה — שום דבר לא נמחק. נסו שוב בעוד רגע." retrying={list.isFetching} />
      ) : null}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">תבניות AI</h1>
        <p className="text-sm text-slate-500">
          ניהול גרסאות prompt לכל playbook. משקלים נורמלים אוטומטית. גרסה לא פעילה לא תיבחר.
        </p>
      </header>

      <CreateVariantForm
        onSubmit={(payload) => create.mutate(payload)}
        submitting={create.isPending}
      />

      {list.isLoading ? (
        <p className="text-slate-500">טוען...</p>
      ) : null}

      {PLAYBOOKS.map((playbook) => (
        <PlaybookSection
          key={playbook}
          playbook={playbook}
          variants={variantsByPlaybook[playbook] ?? []}
          onUpdate={(payload) => update.mutate(payload)}
          onDelete={(id) => remove.mutate(id)}
          updating={update.isPending}
          deleting={remove.isPending}
        />
      ))}
    </div>
  );
}

function PlaybookSection({
  playbook, variants, onUpdate, onDelete, updating, deleting,
}: {
  playbook: PlaybookName;
  variants: PromptVariantRow[];
  onUpdate: (input: { id: string; weight?: number; is_active?: boolean; prompt_overrides?: PromptVariantRow['prompt_overrides']; notes?: string | null; lead_segment_filter?: PromptVariantRow['lead_segment_filter'] }) => void;
  onDelete: (id: string) => void;
  updating: boolean;
  deleting: boolean;
}) {
  const totalWeight = variants.filter((v) => v.is_active).reduce((acc, v) => acc + Math.max(0, v.weight), 0);
  return (
    <section className="kf-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold tracking-tight">{playbook}</h2>
        <span className="text-xs text-slate-500">
          {variants.length} גרסאות · משקל פעיל {totalWeight}
        </span>
      </div>
      {variants.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">אין גרסאות. ה-AI ירוץ עם הגרסה הקבועה ב-config.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {variants.map((v) => (
            <VariantRow
              key={v.id}
              variant={v}
              activeShare={totalWeight > 0 && v.is_active ? Math.round((Math.max(0, v.weight) / totalWeight) * 100) : 0}
              onUpdate={onUpdate}
              onDelete={onDelete}
              updating={updating}
              deleting={deleting}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function VariantRow({
  variant, activeShare, onUpdate, onDelete, updating, deleting,
}: {
  variant: PromptVariantRow;
  activeShare: number;
  onUpdate: (input: { id: string; weight?: number; is_active?: boolean; prompt_overrides?: PromptVariantRow['prompt_overrides']; notes?: string | null; lead_segment_filter?: PromptVariantRow['lead_segment_filter'] }) => void;
  onDelete: (id: string) => void;
  updating: boolean;
  deleting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [objective, setObjective] = useState(variant.prompt_overrides.objective ?? '');
  const [guidanceText, setGuidanceText] = useState((variant.prompt_overrides.guidance ?? []).join('\n'));
  const [notes, setNotes] = useState(variant.notes ?? '');
  const [segmentHeat, setSegmentHeat] = useState((variant.lead_segment_filter?.heat ?? []).join(','));
  const [segmentSource, setSegmentSource] = useState((variant.lead_segment_filter?.source ?? []).join(','));
  const [segmentStatus, setSegmentStatus] = useState((variant.lead_segment_filter?.status ?? []).join(','));

  function parseCsv(s: string): string[] | undefined {
    const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  }

  function saveOverrides() {
    const guidance = guidanceText.split('\n').map((l) => l.trim()).filter(Boolean);
    const segmentFilter: PromptVariantRow['lead_segment_filter'] = {};
    const heatParts = parseCsv(segmentHeat);
    const sourceParts = parseCsv(segmentSource);
    const statusParts = parseCsv(segmentStatus);
    if (heatParts) segmentFilter.heat = heatParts;
    if (sourceParts) segmentFilter.source = sourceParts;
    if (statusParts) segmentFilter.status = statusParts;
    onUpdate({
      id: variant.id,
      prompt_overrides: {
        ...variant.prompt_overrides,
        objective: objective.trim() || undefined,
        guidance: guidance.length > 0 ? guidance : undefined,
      },
      notes: notes.trim() || null,
      lead_segment_filter: segmentFilter,
    });
  }

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <code className="rounded bg-slate-100 px-1.5 py-0.5 text-sm font-medium">{variant.version}</code>
            {variant.is_active
              ? <span className="kf-badge kf-badge-success">פעילה</span>
              : <span className="kf-badge kf-badge-mute">מושבתת</span>}
            {activeShare > 0 ? (
              <span className="text-xs text-slate-500">חלוקה: {activeShare}%</span>
            ) : null}
          </div>
          <div className="mt-1 text-xs text-slate-500" title={variant.created_at}>
            עודכן {formatDateTime(variant.updated_at)}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-slate-600">משקל</span>
          <input
            type="number" min={0} max={100}
            className="kf-input w-20"
            defaultValue={variant.weight}
            disabled={updating}
            onBlur={(e) => {
              const next = Number(e.currentTarget.value);
              if (Number.isFinite(next) && next !== variant.weight) {
                onUpdate({ id: variant.id, weight: next });
              }
            }}
          />
        </label>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            checked={variant.is_active}
            disabled={updating}
            onChange={(e) => onUpdate({ id: variant.id, is_active: e.target.checked })}
          />
          <span className="text-slate-700">פעילה</span>
        </label>
        <div className="flex items-center gap-2 justify-self-end">
          <button type="button" className="kf-btn text-xs" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'סגור' : 'ערוך תבנית'}
          </button>
          <button
            type="button"
            className="kf-btn kf-btn-danger text-xs"
            disabled={deleting}
            onClick={() => {
              if (window.confirm(`למחוק את הגרסה ${variant.version}?`)) onDelete(variant.id);
            }}
          >
            מחיקה
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="mt-3 grid grid-cols-1 gap-3 border-t border-slate-100 pt-3">
          <label className="block text-sm">
            <span className="text-slate-700">מטרה (objective override)</span>
            <textarea
              className="kf-input mt-1 min-h-[60px]"
              placeholder="ברירת מחדל: ה-objective של ה-playbook"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-700">הנחיות (שורה לכל בולט)</span>
            <textarea
              className="kf-input mt-1 min-h-[100px] font-mono text-xs"
              placeholder="ברירת מחדל: ה-guidance של ה-playbook"
              value={guidanceText}
              onChange={(e) => setGuidanceText(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-700">הערות (פנימיות)</span>
            <input
              className="kf-input mt-1"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <fieldset className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
            <legend className="px-1 text-xs font-semibold text-slate-600">סינון לפי סגמנט (אופציונלי)</legend>
            <p className="text-xs text-slate-500">השאר ריק כדי להפעיל על כל הלידים. ערכים מופרדים בפסיק.</p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className="text-xs text-slate-700">
                heat
                <input
                  className="kf-input mt-1"
                  placeholder="hot,warm"
                  value={segmentHeat}
                  onChange={(e) => setSegmentHeat(e.target.value)}
                />
              </label>
              <label className="text-xs text-slate-700">
                source
                <input
                  className="kf-input mt-1"
                  placeholder="webinar,instagram_dm"
                  value={segmentSource}
                  onChange={(e) => setSegmentSource(e.target.value)}
                />
              </label>
              <label className="text-xs text-slate-700">
                status
                <input
                  className="kf-input mt-1"
                  placeholder="responded,qualified"
                  value={segmentStatus}
                  onChange={(e) => setSegmentStatus(e.target.value)}
                />
              </label>
            </div>
          </fieldset>
          <div className="flex justify-end">
            <button type="button" className="kf-btn kf-btn-primary" onClick={saveOverrides} disabled={updating}>
              שמור שינויים
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function CreateVariantForm({
  onSubmit, submitting,
}: {
  onSubmit: (payload: { playbook_name: PlaybookName; version: string; weight: number; is_active: boolean; notes?: string | null }) => void;
  submitting: boolean;
}) {
  const [playbook, setPlaybook] = useState<PlaybookName>('qualification');
  const [version, setVersion] = useState('');
  const [weight, setWeight] = useState('50');
  const [isActive, setIsActive] = useState(true);
  const [notes, setNotes] = useState('');

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!version.trim()) return;
    onSubmit({
      playbook_name: playbook,
      version: version.trim(),
      weight: Number(weight) || 0,
      is_active: isActive,
      notes: notes.trim() || null,
    });
    setVersion(''); setWeight('50'); setNotes(''); setIsActive(true);
  }

  return (
    <form onSubmit={submit} className="kf-card grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-2 md:grid-cols-6">
      <label className="block text-sm md:col-span-2">
        <span className="text-slate-700">תסריט</span>
        <select className="kf-input mt-1" value={playbook} onChange={(e) => setPlaybook(e.target.value as PlaybookName)}>
          {PLAYBOOKS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      <label className="block text-sm">
        <span className="text-slate-700">Version</span>
        <input className="kf-input mt-1" required value={version} onChange={(e) => setVersion(e.target.value)} placeholder="v2-friendlier" />
      </label>
      <label className="block text-sm">
        <span className="text-slate-700">משקל</span>
        <input className="kf-input mt-1" type="number" min={0} max={100} value={weight} onChange={(e) => setWeight(e.target.value)} />
      </label>
      <label className="block text-sm md:col-span-1">
        <span className="text-slate-700">הערות</span>
        <input className="kf-input mt-1" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="flex items-center justify-between gap-3 sm:col-span-2 md:col-span-6">
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            checked={isActive} onChange={(e) => setIsActive(e.target.checked)}
          />
          <span className="text-slate-700">פעילה מיד</span>
        </label>
        <button type="submit" className="kf-btn kf-btn-primary" disabled={submitting}>
          {submitting ? 'מוסיף...' : 'הוספת גרסה'}
        </button>
      </div>
    </form>
  );
}
