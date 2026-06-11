import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchLeadSources, postCreateLeadSource, postDeleteLeadSource, postUpdateLeadSource,
  type LeadSource,
} from '@/lib/api';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { PageIntro } from '@/components/PageIntro';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { t } from '@/lib/i18n';

const SLUG_RE = /^[a-z][a-z0-9_]{1,39}$/;

export function SourcesPage() {
  useDocumentTitle('מקורות לידים');
  const toast = useToast();
  const qc = useQueryClient();

  const sourcesQ = useQuery({ queryKey: ['lead-sources'], queryFn: fetchLeadSources });

  const create = useMutation({
    mutationFn: postCreateLeadSource,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-sources'] });
      toast.success('מקור נוסף');
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const update = useMutation({
    mutationFn: postUpdateLeadSource,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lead-sources'] }),
    onError: (err) => toast.error((err as Error).message),
  });
  const del = useMutation({
    mutationFn: postDeleteLeadSource,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-sources'] });
      toast.success('מקור נמחק');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const [pendingDelete, setPendingDelete] = useState<LeadSource | null>(null);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">מקורות לידים</h1>
        <span className="text-sm text-slate-500">
          {sourcesQ.data?.length ?? 0} מקורות
        </span>
      </header>

      <PageIntro>
        מקור חדש שמוגדר כאן (לדוגמה <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-mono text-slate-800">tiktok_ads</code>) יתקבל
        אוטומטית ב-webhook של leads-intake בלי דרישה לפריסה. ה-slug ננעל אחרי
        יצירה. ניתן להשהות מקור (במקום למחוק) באמצעות כיבוי "פעיל". המקור{' '}
        <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-mono text-slate-800">unknown</code> נשמר כברירת מחדל ולא ניתן למחקו.
      </PageIntro>

      <CreateForm
        onSubmit={(slug, display_name, sort_order) =>
          create.mutate({ slug, display_name, sort_order })
        }
        busy={create.isPending}
      />

      <div className="kf-card overflow-hidden md:overflow-visible">
        <table className="kf-table kf-table-responsive">
          <thead>
            <tr>
              <th>Slug</th>
              <th>שם תצוגה</th>
              <th>סדר</th>
              <th>חוזי intake</th>
              <th>פעיל</th>
              <th>עדכון אחרון</th>
              <th>פעולות</th>
            </tr>
          </thead>
          <tbody>
            {sourcesQ.isLoading ? (
              <tr><td colSpan={7} className="p-6 text-center text-slate-500">{t('loading')}</td></tr>
            ) : sourcesQ.data && sourcesQ.data.length > 0 ? (
              sourcesQ.data.map((s) => (
                <tr key={s.slug} className={s.is_active ? undefined : 'opacity-60'}>
                  <td data-primary>
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-mono text-slate-800">{s.slug}</code>
                  </td>
                  <td data-label="שם תצוגה">
                    <EditableText
                      value={s.display_name}
                      maxLength={60}
                      onSave={(v) => update.mutate({ slug: s.slug, display_name: v })}
                    />
                  </td>
                  <td data-label="סדר">
                    <input
                      type="number" min={0} max={9999}
                      defaultValue={s.sort_order}
                      className="kf-input w-20"
                      onBlur={(e) => {
                        const next = Number(e.target.value);
                        if (Number.isFinite(next) && next !== s.sort_order) {
                          update.mutate({ slug: s.slug, sort_order: next });
                        }
                      }}
                    />
                  </td>
                  <td data-label="חוזי intake">
                    <IntakeContractsCell source={s} />
                  </td>
                  <td data-label="פעיל">
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={s.is_active}
                        onChange={(e) => update.mutate({ slug: s.slug, is_active: e.target.checked })}
                      />
                      <span>{s.is_active ? 'פעיל' : 'מושהה'}</span>
                    </label>
                  </td>
                  <td data-label="עדכון אחרון" className="text-slate-500 text-xs">
                    {new Date(s.updated_at).toLocaleString('he-IL')}
                  </td>
                  <td data-actions>
                    {s.slug !== 'unknown' ? (
                      <button
                        type="button"
                        className="kf-btn kf-btn-danger text-xs"
                        onClick={() => setPendingDelete(s)}
                      >
                        מחיקה
                      </button>
                    ) : (
                      <span className="text-xs text-slate-400">נעול</span>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr><td colSpan={7} className="p-10 text-center text-slate-500">אין מקורות.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        title={`מחיקת מקור — ${pendingDelete?.slug ?? ''}`}
        description="לידים קיימים שמשתמשים ב-slug הזה ימשיכו לעבוד. הסרת ה-slug רק מסירה אותו מרשימת ה-intake החוקיים. ניתן להחזיר ע״י יצירה מחדש."
        destructive
        confirmLabel="מחיקה"
        busy={del.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          del.mutate(pendingDelete.slug);
          setPendingDelete(null);
        }}
      />
    </div>
  );
}

function IntakeContractsCell({ source }: { source: LeadSource }) {
  const contracts = source.intake_source_contracts ?? [];
  if (!contracts.length) return <span className="text-xs text-slate-400">אין חוזה מוגדר</span>;
  return (
    <div className="flex max-w-xs flex-col gap-1 text-xs">
      {contracts.map((contract) => (
        <div key={contract.contract_key} className={contract.is_active ? 'rounded border border-slate-200 bg-white p-2' : 'rounded border border-slate-200 bg-slate-50 p-2 opacity-60'}>
          <div className="font-medium text-slate-800">{contract.display_name}</div>
          <code className="mt-0.5 block text-[11px] text-slate-500" dir="ltr">{contract.contract_key}</code>
          <div className="mt-1 text-slate-500">
            {contract.default_track ? `מסלול: ${contract.default_track}` : 'מסלול לפי payload'}
            {contract.default_stage ? ` · שלב: ${contract.default_stage}` : ''}
          </div>
          {contract.required_fields?.length ? (
            <div className="mt-1 text-slate-500">חובה: {contract.required_fields.join(', ')}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function CreateForm({
  onSubmit, busy,
}: { onSubmit: (slug: string, displayName: string, sortOrder: number) => void; busy: boolean }) {
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [sortOrder, setSortOrder] = useState('100');
  const slugError = slug && !SLUG_RE.test(slug) ? 'אותיות קטנות, ספרות וקווים תחתונים בלבד (2-40 תווים, מתחיל באות)' : '';

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!slug || slugError || !displayName.trim()) return;
    onSubmit(slug, displayName.trim(), Number(sortOrder) || 100);
    setSlug('');
    setDisplayName('');
    setSortOrder('100');
  }

  return (
    <form onSubmit={submit} className="kf-card grid grid-cols-1 gap-3 p-4 sm:grid-cols-4">
      <label className="text-sm">
        <span className="text-slate-600">Slug</span>
        <input
          className="kf-input mt-1 ltr"
          placeholder="tiktok_ads"
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          maxLength={40}
          dir="ltr"
        />
        {slugError ? <span className="mt-1 block text-xs text-rose-600">{slugError}</span> : null}
      </label>
      <label className="text-sm">
        <span className="text-slate-600">שם תצוגה</span>
        <input
          className="kf-input mt-1"
          placeholder="TikTok Ads"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={60}
        />
      </label>
      <label className="text-sm">
        <span className="text-slate-600">סדר תצוגה</span>
        <input
          className="kf-input mt-1"
          type="number" min={0} max={9999}
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
        />
      </label>
      <div className="flex items-end">
        <button
          type="submit"
          className="kf-btn kf-btn-primary w-full"
          disabled={busy || !slug || !!slugError || !displayName.trim()}
        >
          {busy ? '...' : 'הוספה'}
        </button>
      </div>
    </form>
  );
}

function EditableText({
  value, maxLength, onSave,
}: { value: string; maxLength: number; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <button
        type="button"
        className="text-start text-sm text-slate-800 hover:text-brand-700"
        onClick={() => { setDraft(value); setEditing(true); }}
      >
        {value}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        autoFocus
        className="kf-input text-sm"
        value={draft}
        maxLength={maxLength}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
          if (e.key === 'Enter') {
            const next = draft.trim();
            if (next && next !== value) onSave(next);
            setEditing(false);
          }
        }}
      />
      <button
        type="button"
        className="kf-btn kf-btn-primary text-xs"
        onClick={() => {
          const next = draft.trim();
          if (next && next !== value) onSave(next);
          setEditing(false);
        }}
      >
        שמירה
      </button>
      <button type="button" className="kf-btn text-xs" onClick={() => setEditing(false)}>ביטול</button>
    </span>
  );
}
