import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchRuntimeConfig, postUpdateActiveHours, type ActiveHoursConfig } from '@/lib/api';
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
    </div>
  );
}
