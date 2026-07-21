import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  fetchBroadcasts,
  fetchBroadcast,
  fetchMessageTemplates,
  previewBroadcastSegment,
  postBroadcastAction,
  type BroadcastAction,
} from '@/lib/api';
import type {
  BroadcastRow,
  BroadcastStatus,
  BroadcastSegment,
  MessageTemplateRow,
} from '@/lib/types';
import { useToast } from '@/components/Toast';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { PageIntro } from '@/components/PageIntro';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { SOURCE_LABELS, formatRelative } from '@/lib/format';

const STATUS_LABELS: Record<BroadcastStatus, string> = {
  draft: 'טיוטה',
  scheduled: 'מתוזמן',
  sending: 'בשליחה',
  sent: 'נשלח',
  cancelled: 'בוטל',
  failed: 'נכשל',
};

const STATUS_TONE: Record<BroadcastStatus, string> = {
  draft: 'text-slate-500',
  scheduled: 'text-sky-700',
  sending: 'text-amber-700',
  sent: 'text-emerald-700',
  cancelled: 'text-slate-400',
  failed: 'text-rose-700',
};

// Fields an operator can segment on, with Hebrew labels. One Hebrew label
// fronts several raw slugs (e.g. "אתר" → website / landing_page /
// services_page), so each option carries ALL its slugs comma-joined and
// the backend matches with IN — same pattern as the LeadsPage source
// filter. Picking one slug per label silently under-targeted broadcasts.
export const SOURCE_OPTIONS: Array<{ value: string; label: string }> = (() => {
  const byLabel = new Map<string, string[]>();
  for (const [slug, label] of Object.entries(SOURCE_LABELS)) {
    const arr = byLabel.get(label) ?? [];
    arr.push(slug);
    byLabel.set(label, arr);
  }
  return Array.from(byLabel.entries()).map(([label, slugs]) => ({ value: slugs.join(','), label }));
})();
const TRACK_OPTIONS = [
  { value: 'program', label: 'הדרך לדירה' },
  { value: 'presale', label: 'פריסייל' },
  { value: 'investor_mentorship', label: 'ליווי משקיעים' },
];

export function BroadcastsPage() {
  useDocumentTitle('הודעות תפוצה');
  const toast = useToast();
  const qc = useQueryClient();

  const q = useQuery({ queryKey: ['broadcasts'], queryFn: fetchBroadcasts });
  const broadcasts = q.data?.broadcasts ?? [];

  const [composing, setComposing] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const act = useMutation({
    mutationFn: (payload: BroadcastAction) => postBroadcastAction(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">הודעות תפוצה</h1>
        <button className="kf-btn kf-btn-primary" onClick={() => setComposing(true)}>
          תפוצה חדשה
        </button>
      </header>

      <PageIntro>
        שליחת הודעה אחת לסגמנט של לידים, מתוזמנת לשעה מדויקת, דרך וואטסאפ. השליחה
        עוברת דרך תור הבוט בעדיפות נמוכה — כך תפוצה גדולה לעולם לא חוסמת את
        המענה בזמן אמת. וואטסאפ לנמענים שלא כתבו לבוט ב-24 השעות האחרונות מחייב
        תבנית מאושרת של Meta (בוחרים תבנית, לא כותבים טקסט חופשי). מייל יתווסף בהמשך.
      </PageIntro>

      {q.isLoading ? <p className="text-slate-500">טוען…</p> : null}

      {broadcasts.length === 0 && !q.isLoading ? (
        <p className="text-slate-500">עדיין לא נוצרו הודעות תפוצה.</p>
      ) : null}

      <section className="space-y-3">
        {broadcasts.map((b) => (
          <BroadcastCard
            key={b.id}
            broadcast={b}
            busy={act.isPending}
            onOpen={() => setDetailId(b.id)}
            onSchedule={() => act.mutate({ action: 'schedule', id: b.id })}
            onCancel={() => act.mutate({ action: 'cancel', id: b.id })}
            onDelete={() => {
              if (confirm('למחוק את התפוצה?')) act.mutate({ action: 'delete', id: b.id });
            }}
          />
        ))}
      </section>

      {composing ? (
        <ComposeDialog
          onClose={() => setComposing(false)}
          onSaved={() => {
            setComposing(false);
            qc.invalidateQueries({ queryKey: ['broadcasts'] });
          }}
        />
      ) : null}

      {detailId ? <DetailDialog id={detailId} onClose={() => setDetailId(null)} /> : null}
    </div>
  );
}

function BroadcastCard({
  broadcast: b,
  busy,
  onOpen,
  onSchedule,
  onCancel,
  onDelete,
}: {
  broadcast: BroadcastRow;
  busy: boolean;
  onOpen: () => void;
  onSchedule: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="kf-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <button className="text-lg font-semibold hover:underline" onClick={onOpen}>
            {b.name}
          </button>
          <span className="ms-2 text-xs text-slate-400">{b.channel === 'whatsapp' ? 'וואטסאפ' : 'מייל'}</span>
        </div>
        <span className={clsx('text-sm font-medium', STATUS_TONE[b.status])}>{STATUS_LABELS[b.status]}</span>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
        <span>נמענים: <b className="tabular-nums">{b.recipients_count}</b></span>
        <span>נשלחו: <b className="tabular-nums">{b.sent_count}</b></span>
        {b.skipped_count > 0 ? <span>דולגו: <b className="tabular-nums">{b.skipped_count}</b></span> : null}
        {b.scheduled_at ? (
          <span>מתוזמן: {new Date(b.scheduled_at).toLocaleString('he-IL')}</span>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button className="kf-btn kf-btn-ghost" onClick={onOpen}>פרטים ואנליטיקה</button>
        {b.status === 'draft' ? (
          <button className="kf-btn kf-btn-primary" onClick={onSchedule} disabled={busy}>תזמן שליחה</button>
        ) : null}
        {b.status === 'scheduled' || b.status === 'sending' ? (
          <button className="kf-btn kf-btn-danger" onClick={onCancel} disabled={busy}>ביטול</button>
        ) : null}
        {b.status === 'draft' || b.status === 'cancelled' || b.status === 'failed' ? (
          <button className="kf-btn kf-btn-ghost" onClick={onDelete} disabled={busy}>מחק</button>
        ) : null}
      </div>
    </div>
  );
}

const DEFAULT_UI_PACING = { perTick: 20, dailyCap: 250 };

function ComposeDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  // Live pacing knobs from the broadcasts list response (crm_config
  // broadcast_pacing) — falls back to the seeded defaults until loaded.
  const pacingQ = useQuery({ queryKey: ['broadcasts'], queryFn: fetchBroadcasts });
  const pacing = pacingQ.data?.pacing ?? DEFAULT_UI_PACING;
  const toast = useToast();
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<'whatsapp' | 'email'>('whatsapp');
  const [source, setSource] = useState('');
  const [sourceCampaign, setSourceCampaign] = useState('');
  const [primaryTrack, setPrimaryTrack] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [metaName, setMetaName] = useState('');
  const [subject, setSubject] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');

  const templatesQ = useQuery({
    queryKey: ['message-templates', channel, 'active'],
    queryFn: () => fetchMessageTemplates({ channel, status: 'active' }),
  });
  const templates = templatesQ.data?.templates ?? [];

  const segment: BroadcastSegment = useMemo(
    () => ({
      source: source || undefined,
      source_campaign: sourceCampaign || undefined,
      primary_track: primaryTrack || undefined,
    }),
    [source, sourceCampaign, primaryTrack],
  );
  const debouncedSegment = useDebouncedValue(segment, 400);

  const previewQ = useQuery({
    queryKey: ['broadcast-preview', debouncedSegment, channel],
    queryFn: () => previewBroadcastSegment(debouncedSegment, channel),
  });

  const selectedTemplate = templates.find((t) => t.key === templateKey);

  const save = useMutation({
    mutationFn: () =>
      postBroadcastAction({
        action: 'create',
        name: name.trim(),
        channel,
        template_key: templateKey || null,
        meta_template: channel === 'whatsapp' && metaName ? { name: metaName.trim(), lang: 'he', params: [] } : null,
        subject: channel === 'email' ? subject.trim() : undefined,
        body_html: channel === 'email' ? (bodyHtml.trim() || selectedTemplateHtml || undefined) : undefined,
        segment,
        scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
      }),
    onSuccess: () => {
      toast.success('טיוטת תפוצה נשמרה');
      onSaved();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const selectedTemplateHtml = (selectedTemplate as { body_html?: string | null } | undefined)?.body_html ?? '';
  const canSave =
    name.trim().length > 0 &&
    (channel === 'whatsapp'
      ? !!metaName.trim()
      : !!subject.trim() && !!(bodyHtml.trim() || selectedTemplateHtml || selectedTemplate?.body));

  return (
    <Modal title="תפוצה חדשה" onClose={onClose}>
      <div className="space-y-3">
        <Field label="שם התפוצה (פנימי)">
          <input className="kf-input w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="למשל: תזכורת וובינר השקה" />
        </Field>

        <Field label="ערוץ">
          <div className="flex gap-2">
            {([['whatsapp', '💬 וואטסאפ'], ['email', '📧 מייל']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => { setChannel(value); setTemplateKey(''); }}
                className={
                  channel === value
                    ? 'rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white'
                    : 'rounded-lg bg-white px-4 py-2 text-sm text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
                }
              >
                {label}
              </button>
            ))}
          </div>
        </Field>
        {channel === 'email' ? (
          <p className="text-xs text-slate-500">
            תפוצת מייל נשלחת דרך רב מסר: המערכת יוצרת שם רשימה ייעודית, מוסיפה אליה את
            הנמענים (רק מי שיש לו מייל והסכמת דיוור), ושולחת את הקמפיין. הסרות ופתיחות
            מנוהלות ברב מסר.
          </p>
        ) : null}

        <fieldset className="rounded-lg border border-slate-200 p-3">
          <legend className="px-1 text-sm font-medium text-slate-600">סגמנט נמענים</legend>
          <div className="grid gap-2 md:grid-cols-3">
            <Field label="מקור">
              <select className="kf-input w-full" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">הכול</option>
                {SOURCE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label="מסלול">
              <select className="kf-input w-full" value={primaryTrack} onChange={(e) => setPrimaryTrack(e.target.value)}>
                <option value="">הכול</option>
                {TRACK_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label="קמפיין (source_campaign)">
              <input className="kf-input w-full" dir="ltr" value={sourceCampaign}
                onChange={(e) => setSourceCampaign(e.target.value)} placeholder="launch_webinar_2026" />
            </Field>
          </div>
          <p className="mt-2 text-sm text-slate-600">
            נמענים תואמים:{' '}
            <b className="tabular-nums">{previewQ.isLoading ? '…' : previewQ.data?.count ?? 0}</b>
            {(previewQ.data?.count ?? 0) > 0 ? (
              <span className="ms-2 text-slate-500">
                השליחה מדורגת אוטומטית (עד ~{pacing.perTick} בדקה, עד {pacing.dailyCap.toLocaleString()} נמענים
                ביממה) כדי להגן על דירוג המספר בוואטסאפ.
              </span>
            ) : null}
            {(previewQ.data?.count ?? 0) > pacing.dailyCap ? (
              <span className="ms-2 text-amber-700">
                מעל התקרה היומית — התפוצה תתפרס אוטומטית על פני כ-
                {Math.ceil((previewQ.data?.count ?? 0) / pacing.dailyCap)} ימים, וניתן להגדיל את התקרה בהגדרת broadcast_pacing.
              </span>
            ) : null}
          </p>
        </fieldset>

        <Field label="תבנית CRM (לתצוגה מקדימה של הטקסט)">
          <select className="kf-input w-full" value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
            <option value="">— בחר תבנית —</option>
            {templates.map((t: MessageTemplateRow) => (
              <option key={t.id} value={t.key}>{t.name_he} ({t.key})</option>
            ))}
          </select>
        </Field>
        {selectedTemplate ? (
          channel === 'email' && selectedTemplateHtml ? (
            <iframe
              title="תצוגה מקדימה של תבנית המייל"
              sandbox=""
              className="h-48 w-full rounded-lg border border-slate-200 bg-white"
              srcDoc={`<div dir="rtl" style="font-family:Arial,sans-serif; padding:12px; text-align:right;">${selectedTemplateHtml}</div>`}
            />
          ) : (
            <div className="rounded-lg bg-slate-50 p-3 text-sm whitespace-pre-wrap">{selectedTemplate.body}</div>
          )
        ) : null}

        {channel === 'whatsapp' ? (
          <>
            <Field label="שם תבנית Meta מאושרת (נשלחת בפועל)">
              <input className="kf-input w-full" dir="ltr" value={metaName}
                onChange={(e) => setMetaName(e.target.value)} placeholder="webinar_launch_reminder" />
            </Field>
            <p className="text-xs text-slate-500">
              וואטסאפ לנמענים קרים חייב תבנית מאושרת של Meta. הזן את שם התבנית בדיוק כפי שאושרה.
            </p>
          </>
        ) : (
          <>
            <Field label="נושא המייל">
              <input className="kf-input w-full" value={subject}
                onChange={(e) => setSubject(e.target.value)} placeholder="למשל: הוובינר מתחיל הערב ב-20:30" />
            </Field>
            <Field label="גוף המייל (HTML פשוט — אם ריק, ישמש גוף התבנית שנבחרה)">
              <textarea
                className="kf-input w-full font-mono text-xs"
                dir="ltr"
                rows={6}
                value={bodyHtml}
                onChange={(e) => setBodyHtml(e.target.value)}
                placeholder={'<p>שלום {{first_name}},</p>\n<p>תוכן ההודעה...</p>'}
              />
            </Field>
          </>
        )}

        <Field label="מועד שליחה">
          <input type="datetime-local" className="kf-input w-full" dir="ltr"
            value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
        </Field>

        <div className="flex justify-end gap-2 pt-2">
          <button className="kf-btn kf-btn-ghost" onClick={onClose}>ביטול</button>
          <button className="kf-btn kf-btn-primary" onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
            שמור טיוטה
          </button>
        </div>
      </div>
    </Modal>
  );
}

const SKIP_REASON_LABELS: Record<string, string> = {
  do_not_contact: 'ביקשו הסרה / לא ליצור קשר',
  no_phone: 'אין מספר טלפון',
  lead_missing: 'הליד נמחק',
  empty_text: 'הודעה ריקה',
  unknown: 'סיבה לא ידועה',
};

function DetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['broadcast', id], queryFn: () => fetchBroadcast(id) });
  const b = q.data?.broadcast;
  const s = q.data?.stats;
  const skipped = q.data?.skipped ?? [];
  const skippedByReason = new Map<string, typeof skipped>();
  for (const r of skipped) {
    const list = skippedByReason.get(r.reason) ?? [];
    list.push(r);
    skippedByReason.set(r.reason, list);
  }

  return (
    <Modal title={b?.name ?? 'תפוצה'} onClose={onClose}>
      {q.isLoading || !b || !s ? (
        <p className="text-slate-500">טוען…</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
            <span>סטטוס: <b className={STATUS_TONE[b.status]}>{STATUS_LABELS[b.status]}</b></span>
            {b.scheduled_at ? <span>מתוזמן: {new Date(b.scheduled_at).toLocaleString('he-IL')}</span> : null}
            <span>עודכן {formatRelative(b.updated_at)}</span>
          </div>

          {/* Recipient statuses (pending/enqueued/sent/skipped/failed) are
              exclusive buckets; delivered/read are OVERLAYS derived from the
              linked messages (a read recipient is still status='sent'). So
              tiles must not sum them — that triple-counted deliveries. */}
          <section className="grid grid-cols-2 gap-2 md:grid-cols-3">
            <StatTile label="נמענים" value={s.total} />
            <StatTile label="בתור" value={s.pending + s.enqueued} tone="text-amber-700" />
            <StatTile label="נשלחו" value={s.sent} tone="text-emerald-700" />
            <StatTile label="נמסרו" value={s.delivered} tone="text-sky-700" />
            <StatTile label="נקראו" value={s.read} tone="text-indigo-700" />
            <StatTile label="נכשלו" value={s.failed} tone="text-rose-700" />
            <StatTile label="דולגו" value={s.skipped} tone="text-slate-500" />
          </section>

          {skipped.length > 0 ? (
            <section>
              <div className="mb-1 text-sm font-medium text-slate-600">פירוט המדולגים</div>
              <div className="space-y-2">
                {Array.from(skippedByReason.entries()).map(([reason, rows]) => (
                  <details key={reason} className="rounded-lg border border-slate-200 bg-white">
                    <summary className="cursor-pointer select-none px-3 py-2 text-sm">
                      <b>{SKIP_REASON_LABELS[reason] ?? reason}</b>
                      <span className="ms-2 tabular-nums text-slate-500">({rows.length})</span>
                    </summary>
                    <ul className="divide-y divide-slate-100 border-t border-slate-100 text-sm">
                      {rows.map((r) => (
                        <li key={r.leadId} className="flex flex-wrap items-center gap-x-3 px-3 py-1.5">
                          <Link to={`/leads/${r.leadId}`} className="font-medium text-brand-700 hover:underline">
                            {r.name || 'ליד ללא שם'}
                          </Link>
                          {r.phone ? <span dir="ltr" className="tabular-nums text-slate-500">{r.phone}</span> : null}
                          {r.source ? <span className="text-xs text-slate-400">{r.source}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
              </div>
            </section>
          ) : null}

          {b.body_snapshot ? (
            <div>
              <div className="mb-1 text-sm font-medium text-slate-600">תוכן ההודעה</div>
              <div className="rounded-lg bg-slate-50 p-3 text-sm whitespace-pre-wrap">{b.body_snapshot}</div>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

function StatTile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="kf-card p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={clsx('mt-1 text-2xl font-semibold tabular-nums', tone)}>{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-slate-600">{label}</span>
      {children}
    </label>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div className="my-8 w-full max-w-2xl rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-xl font-semibold">{title}</h2>
          <button className="text-slate-400 hover:text-slate-600" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
