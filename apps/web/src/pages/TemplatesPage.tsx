import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchMessageTemplates, postMessageTemplateAction } from '@/lib/api';
import type { MessageTemplateRow, TemplateChannel, TemplateStatus } from '@/lib/types';
import { renderTemplate } from '@/lib/template-render';
import { useToast } from '@/components/Toast';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { t } from '@/lib/i18n';
import { PageIntro } from '@/components/PageIntro';

// Tier 7.C.1 — central labels.
import { TEMPLATE_CHANNEL_LABELS, TEMPLATE_STATUS_LABELS } from '@/lib/format';
const CHANNEL_LABELS = TEMPLATE_CHANNEL_LABELS as Record<TemplateChannel, string>;
const STATUS_LABELS = TEMPLATE_STATUS_LABELS as Record<TemplateStatus, string>;

export function TemplatesPage() {
  useDocumentTitle('תבניות הודעה');
  const toast = useToast();
  const qc = useQueryClient();

  const templatesQ = useQuery({ queryKey: ['message-templates'], queryFn: () => fetchMessageTemplates() });

  const action = useMutation({
    mutationFn: postMessageTemplateAction,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['message-templates'] });
      toast.success('עודכן');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const templates = templatesQ.data?.templates ?? [];
  const [editing, setEditing] = useState<MessageTemplateRow | null>(null);

  // Group by channel for the section layout.
  const byChannel = useMemo(() => {
    const groups = new Map<TemplateChannel, MessageTemplateRow[]>();
    for (const t of templatesQ.data?.templates ?? []) {
      if (!groups.has(t.channel)) groups.set(t.channel, []);
      groups.get(t.channel)!.push(t);
    }
    return groups;
  }, [templatesQ.data?.templates]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">תבניות הודעה</h1>
        <span className="text-sm text-slate-500">{templates.length} תבניות</span>
      </header>

      <PageIntro>
        כל הודעה אוטומטית או ידנית חוזרת על אותם משפטים בקרנף. עורך הטקסט כאן —
        בלי שום deploy — והבוט וה-Reply Box יראו את הגרסה המעודכנת מיד.
        משתנים ב-{'{{first_name}}'} מוחלפים אוטומטית מנתוני איש הקשר.
        תבנית בסטטוס "טיוטה" לא תישלח עד שהיא מסומנת כפעילה.
      </PageIntro>

      {templatesQ.isLoading ? <p className="text-slate-500">{t('loading')}</p> : null}

      {Array.from(byChannel.entries()).map(([channel, items]) => (
        <section key={channel} className="kf-card p-4">
          <h2 className="text-lg font-semibold">{CHANNEL_LABELS[channel] ?? channel}</h2>
          <p className="mt-1 text-xs text-slate-500">{items.length} תבניות</p>
          <ul className="mt-3 space-y-2">
            {items.map((tpl) => {
              const preview = renderTemplate(tpl.body, {
                first_name: 'שם הלקוח',
                phone: '050-1234567',
                partner_name: 'שם הפרילנסר',
                meeting_time: 'מחר בשעה 14:00',
                project_name: 'שם הפרויקט',
                city: 'תל אביב',
                deal_value: '1,200,000',
                commission_amount: '36,000',
                investment_budget: '1.5M',
                preferred_area: 'מרכז',
                target_date: '15/07',
              });
              return (
                <li key={tpl.id} className="rounded-lg border border-slate-200 bg-white p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <strong className="text-sm">{tpl.name_he}</strong>
                    <div className="flex items-center gap-2 text-xs">
                      <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-600">{tpl.key}</code>
                      <span className={
                        tpl.status === 'active' ? 'text-emerald-600' :
                        tpl.status === 'draft' ? 'text-amber-600' : 'text-slate-400'
                      }>{STATUS_LABELS[tpl.status]}</span>
                    </div>
                  </div>
                  {tpl.description ? <p className="mt-1 text-xs text-slate-500">{tpl.description}</p> : null}
                  <div className="mt-2 whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-sm leading-6">
                    {preview.text}
                  </div>
                  {tpl.variables_used.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1 text-xs">
                      {tpl.variables_used.map((v) => (
                        <code key={v} className="rounded bg-violet-50 px-1.5 py-0.5 font-mono text-violet-700">
                          {`{{${v}}}`}
                        </code>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-1">
                    <button type="button" className="kf-btn text-xs" onClick={() => setEditing(tpl)}>עריכה</button>
                    {tpl.status === 'active' ? (
                      <button type="button" className="kf-btn text-xs" disabled={action.isPending}
                        onClick={() => action.mutate({ action: 'update', id: tpl.id, status: 'deprecated' })}>
                        הוצא משימוש
                      </button>
                    ) : tpl.status === 'deprecated' ? (
                      <button type="button" className="kf-btn text-xs" disabled={action.isPending}
                        onClick={() => action.mutate({ action: 'update', id: tpl.id, status: 'active' })}>
                        החזר לפעיל
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {editing ? (
        <EditDialog
          template={editing}
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

function EditDialog({
  template,
  busy,
  onSubmit,
  onCancel,
}: {
  template: MessageTemplateRow;
  busy: boolean;
  onSubmit: (patch: { name_he?: string; body?: string; description?: string;
    notes?: string; status?: TemplateStatus }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(template.name_he);
  const [body, setBody] = useState(template.body);
  const [description, setDescription] = useState(template.description ?? '');
  const [notes, setNotes] = useState(template.notes ?? '');
  const [status, setStatus] = useState<TemplateStatus>(template.status);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSubmit({
      name_he: name.trim(),
      body,
      description: description.trim() || undefined,
      notes: notes.trim() || undefined,
      status,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <form className="kf-card max-h-[90vh] w-full max-w-xl space-y-3 overflow-auto p-5" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">עריכת תבנית — {template.key}</h2>
        <label className="block text-sm">
          <span className="text-slate-600">שם תיאורי (עברית)</span>
          <input className="kf-input mt-1" required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="text-slate-600">תיאור קצר</span>
          <input className="kf-input mt-1" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="text-slate-600">גוף ההודעה (השתמש ב-{'{{var}}'} למשתנים)</span>
          <textarea className="kf-input mt-1 min-h-[150px] font-mono leading-6" required
            value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="text-slate-600">סטטוס</span>
            <select className="kf-input mt-1" value={status} onChange={(e) => setStatus(e.target.value as TemplateStatus)}>
              <option value="draft">טיוטה</option>
              <option value="active">פעיל</option>
              <option value="deprecated">הוצא משימוש</option>
            </select>
          </label>
          <div />
        </div>
        <label className="block text-sm">
          <span className="text-slate-600">הערות פנימיות</span>
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
