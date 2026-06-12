import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchRuntimeConfig,
  postUpdateActiveHours,
  postUpdateFollowUpDelays,
  postUpdateForbiddenClaims,
  postUpdateSlaThresholds,
  type ActiveHoursConfig,
  type FollowUpDelaysConfig,
  type SlaThresholdsConfig,
} from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { t } from '@/lib/i18n';

const DAY_LABELS = [
  { value: 0, label: 'ראשון' },
  { value: 1, label: 'שני' },
  { value: 2, label: 'שלישי' },
  { value: 3, label: 'רביעי' },
  { value: 4, label: 'חמישי' },
  { value: 5, label: 'שישי' },
  { value: 6, label: 'שבת' },
];

const DEFAULT_ACTIVE_HOURS: ActiveHoursConfig = {
  start: '09:00',
  end: '21:00',
  timezone: 'Asia/Jerusalem',
  workingDays: [0, 1, 2, 3, 4],
};

export function SettingsPage() {
  useDocumentTitle('הגדרות');
  const toast = useToast();
  const qc = useQueryClient();
  const configQ = useQuery({ queryKey: ['runtime-config'], queryFn: fetchRuntimeConfig });
  const [draft, setDraft] = useState<ActiveHoursConfig>(DEFAULT_ACTIVE_HOURS);

  useEffect(() => {
    if (configQ.data?.activeHours) setDraft(configQ.data.activeHours);
  }, [configQ.data?.activeHours]);

  const update = useMutation({
    mutationFn: postUpdateActiveHours,
    onSuccess: (data) => {
      setDraft(data.activeHours);
      qc.invalidateQueries({ queryKey: ['runtime-config'] });
      toast.success('שעות הפעילות נשמרו');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!draft.workingDays.length) {
      toast.error('צריך לבחור לפחות יום פעילות אחד');
      return;
    }
    update.mutate({ ...draft, workingDays: [...draft.workingDays].sort((a, b) => a - b) });
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">הגדרות מערכת</h1>
        <p className="mt-1 text-sm text-slate-500">הגדרות תפעוליות שמשפיעות על ניתוב ותורי עבודה.</p>
      </header>

      <form onSubmit={submit} className="kf-card max-w-3xl space-y-5 p-5">
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">שעות פעילות לנציגים</h2>
          <p className="text-sm text-slate-500">
            בקשות “נציג אנושי” שמגיעות מחוץ לשעות האלה יקבלו הודעת ציפייה מתאימה וייכנסו לתור לטיפול בפתיחת העבודה הבאה.
          </p>
        </section>

        {configQ.isLoading ? (
          <div className="rounded-lg border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">{t('loading')}</div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="text-sm">
                <span className="text-slate-600">פתיחה</span>
                <input className="kf-input mt-1 ltr" dir="ltr" type="time" value={draft.start} onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))} required />
              </label>
              <label className="text-sm">
                <span className="text-slate-600">סגירה</span>
                <input className="kf-input mt-1 ltr" dir="ltr" type="time" value={draft.end} onChange={(e) => setDraft((d) => ({ ...d, end: e.target.value }))} required />
              </label>
              <label className="text-sm">
                <span className="text-slate-600">אזור זמן</span>
                <select className="kf-input mt-1" value={draft.timezone} onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value as 'Asia/Jerusalem' }))}>
                  <option value="Asia/Jerusalem">Asia/Jerusalem</option>
                </select>
              </label>
            </div>

            <div className="space-y-2">
              <span className="text-sm text-slate-600">ימי פעילות</span>
              <div className="grid gap-2 sm:grid-cols-4">
                {DAY_LABELS.map((day) => {
                  const checked = draft.workingDays.includes(day.value);
                  return (
                    <label key={day.value} className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${checked ? 'border-brand-300 bg-brand-50 text-brand-900' : 'border-slate-200 bg-white text-slate-700'}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => setDraft((d) => ({
                          ...d,
                          workingDays: e.target.checked
                            ? [...new Set([...d.workingDays, day.value])]
                            : d.workingDays.filter((v) => v !== day.value),
                        }))}
                      />
                      <span>{day.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
              ברירת המחדל: ראשון-חמישי, 09:00-21:00. שינוי כאן משפיע על בקשות נציג חדשות מרגע השמירה.
            </div>

            <div className="flex justify-end">
              <button type="submit" className="kf-btn kf-btn-primary" disabled={update.isPending || draft.workingDays.length === 0}>
                {update.isPending ? 'שומר...' : 'שמירת שעות פעילות'}
              </button>
            </div>
          </>
        )}
      </form>

      <FollowUpDelaysCard
        value={configQ.data?.followUpDelays ?? null}
        loading={configQ.isLoading}
        onSaved={() => qc.invalidateQueries({ queryKey: ['runtime-config'] })}
      />

      <SlaThresholdsCard
        value={configQ.data?.slaThresholds ?? null}
        loading={configQ.isLoading}
        onSaved={() => qc.invalidateQueries({ queryKey: ['runtime-config'] })}
      />

      <ForbiddenClaimsCard
        value={configQ.data?.forbiddenClaims ?? null}
        loading={configQ.isLoading}
        onSaved={() => qc.invalidateQueries({ queryKey: ['runtime-config'] })}
      />

      <WhatsAppTemplateReadiness session={configQ.data?.whatsappSession ?? null} loading={configQ.isLoading} />
    </div>
  );
}

// Tier 8.D — the three crm_config keys an admin actually tunes,
// promoted from SQL-only to the UI. Each card mirrors the active-hours
// form pattern: local draft synced from the query, explicit save.

function FollowUpDelaysCard({
  value,
  loading,
  onSaved,
}: {
  value: FollowUpDelaysConfig | null;
  loading: boolean;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<FollowUpDelaysConfig>({ firstResponseMinutes: 30, nurtureHours: 24, paymentPendingHours: 12 });
  useEffect(() => { if (value) setDraft(value); }, [value]);
  const save = useMutation({
    mutationFn: postUpdateFollowUpDelays,
    onSuccess: () => { onSaved(); toast.success('זמני מעקב נשמרו'); },
    onError: (err) => toast.error((err as Error).message),
  });
  return (
    <form
      className="kf-card max-w-3xl space-y-4 p-5"
      onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}
    >
      <div>
        <h2 className="text-lg font-semibold">זמני מעקב ותזכורות</h2>
        <p className="mt-1 text-sm text-slate-500">כמה זמן עובר עד שליד נכנס לתור מענה / חימום / חילוץ תשלום.</p>
      </div>
      {loading ? (
        <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-sm text-slate-500">{t('loading')}</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField label="מענה ראשון (דקות)" value={draft.firstResponseMinutes} min={1} max={1440}
            onChange={(v) => setDraft((d) => ({ ...d, firstResponseMinutes: v }))} />
          <NumberField label="חימום (שעות)" value={draft.nurtureHours} min={1} max={720}
            onChange={(v) => setDraft((d) => ({ ...d, nurtureHours: v }))} />
          <NumberField label="תשלום ממתין (שעות)" value={draft.paymentPendingHours} min={1} max={336}
            onChange={(v) => setDraft((d) => ({ ...d, paymentPendingHours: v }))} />
        </div>
      )}
      <div className="flex justify-end">
        <button type="submit" className="kf-btn kf-btn-primary" disabled={save.isPending || loading}>
          {save.isPending ? 'שומר...' : 'שמירה'}
        </button>
      </div>
    </form>
  );
}

function SlaThresholdsCard({
  value,
  loading,
  onSaved,
}: {
  value: SlaThresholdsConfig | null;
  loading: boolean;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<SlaThresholdsConfig>({ firstResponseWarnHours: 8, firstResponseHighWarnHours: 10, firstResponseBreachHours: 12, paymentPendingHours: 24 });
  useEffect(() => { if (value) setDraft(value); }, [value]);
  const save = useMutation({
    mutationFn: postUpdateSlaThresholds,
    onSuccess: () => { onSaved(); toast.success('ספי SLA נשמרו'); },
    onError: (err) => toast.error((err as Error).message),
  });
  return (
    <form
      className="kf-card max-w-3xl space-y-4 p-5"
      onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}
    >
      <div>
        <h2 className="text-lg font-semibold">ספי SLA</h2>
        <p className="mt-1 text-sm text-slate-500">מתי ליד בלי מענה נחשב באזהרה / אזהרה גבוהה / חריגה. הסדר חייב להיות עולה.</p>
      </div>
      {loading ? (
        <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-sm text-slate-500">{t('loading')}</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-4">
          <NumberField label="אזהרה (שעות)" value={draft.firstResponseWarnHours} min={1} max={168}
            onChange={(v) => setDraft((d) => ({ ...d, firstResponseWarnHours: v }))} />
          <NumberField label="אזהרה גבוהה (שעות)" value={draft.firstResponseHighWarnHours} min={1} max={168}
            onChange={(v) => setDraft((d) => ({ ...d, firstResponseHighWarnHours: v }))} />
          <NumberField label="חריגה (שעות)" value={draft.firstResponseBreachHours} min={1} max={168}
            onChange={(v) => setDraft((d) => ({ ...d, firstResponseBreachHours: v }))} />
          <NumberField label="תשלום ממתין (שעות)" value={draft.paymentPendingHours} min={1} max={168}
            onChange={(v) => setDraft((d) => ({ ...d, paymentPendingHours: v }))} />
        </div>
      )}
      <div className="flex justify-end">
        <button type="submit" className="kf-btn kf-btn-primary" disabled={save.isPending || loading}>
          {save.isPending ? 'שומר...' : 'שמירה'}
        </button>
      </div>
    </form>
  );
}

function ForbiddenClaimsCard({
  value,
  loading,
  onSaved,
}: {
  value: string[] | null;
  loading: boolean;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  useEffect(() => { if (value) setText(value.join('\n')); }, [value]);
  const save = useMutation({
    mutationFn: postUpdateForbiddenClaims,
    onSuccess: () => { onSaved(); toast.success('רשימת ההצהרות האסורות נשמרה'); },
    onError: (err) => toast.error((err as Error).message),
  });
  return (
    <form
      className="kf-card max-w-3xl space-y-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        const claims = text.split('\n').map((c) => c.trim()).filter(Boolean);
        if (claims.length === 0) { toast.error('נדרשת לפחות הצהרה אחת'); return; }
        save.mutate(claims);
      }}
    >
      <div>
        <h2 className="text-lg font-semibold">הצהרות אסורות ל-AI</h2>
        <p className="mt-1 text-sm text-slate-500">
          ביטויים שהבוט חסום מלהגיד ללקוחות (למשל הבטחות תשואה). שורה לכל ביטוי. החסימה נאכפת על כל תשובת AI לפני שליחה.
        </p>
      </div>
      {loading ? (
        <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-sm text-slate-500">{t('loading')}</div>
      ) : (
        <textarea
          className="kf-input min-h-[140px] font-mono text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'תשואה מובטחת\nמבטיח רווח'}
        />
      )}
      <div className="flex justify-end">
        <button type="submit" className="kf-btn kf-btn-primary" disabled={save.isPending || loading}>
          {save.isPending ? 'שומר...' : 'שמירה'}
        </button>
      </div>
    </form>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="text-sm">
      <span className="text-slate-600">{label}</span>
      <input
        className="kf-input mt-1 ltr" dir="ltr" type="number" min={min} max={max} value={value}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Math.round(Number(e.target.value) || min))))}
        required
      />
    </label>
  );
}

function WhatsAppTemplateReadiness({
  session,
  loading,
}: {
  session: { freeformWindowHours: number; fallbackTemplateName: string; templateConfigured: boolean; templateApprovalRequired: boolean } | null;
  loading: boolean;
}) {
  const hasName = Boolean(session?.fallbackTemplateName);
  return (
    <section className="kf-card max-w-3xl space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">WhatsApp — פתיחת שיחה אחרי 24 שעות</h2>
          <p className="mt-1 text-sm text-slate-500">
            וואטסאפ לא מאפשרת הודעה חופשית אחרי חלון השיחה. כדי ליזום חזרה ללקוח צריך תבנית Meta מאושרת בעברית.
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${hasName ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-700'}`}>
          {hasName ? 'דורש אישור Meta' : 'לא מוגדר'}
        </span>
      </div>

      {loading ? (
        <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-sm text-slate-500">{t('loading')}</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-slate-50 p-3 text-sm">
            <div className="text-slate-500">שם תבנית fallback</div>
            <code className="mt-1 block text-slate-900" dir="ltr">{session?.fallbackTemplateName || '—'}</code>
          </div>
          <div className="rounded-xl bg-slate-50 p-3 text-sm">
            <div className="text-slate-500">חלון הודעה חופשית</div>
            <div className="mt-1 font-medium text-slate-900">{session?.freeformWindowHours ?? 24} שעות</div>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        סטטוס ידוע: הקונפיג מפנה ל־<code dir="ltr">karnaf_followup_v1</code>, אבל Meta החזירה שהתבנית לא קיימת בשפה <code dir="ltr">he</code>. צריך WABA/Meta Business access כדי ליצור ולאשר אותה.
      </div>
    </section>
  );
}
