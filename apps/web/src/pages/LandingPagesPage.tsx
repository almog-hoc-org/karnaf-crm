import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchLandingPages, postLandingPageAction } from '@/lib/api';
import type { LandingPageRow } from '@/lib/types';
import { useToast } from '@/components/Toast';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { PageIntro } from '@/components/PageIntro';

// דפי נחיתה פנימיים: כל שורה כאן היא דף ציבורי חי ב-/api/lp/{slug}.
// הרשמות מהדף נכנסות ישר ללידים עם source_campaign = הקמפיין של הדף,
// כך שכל דף הוא גם "רשימה" מוכנה לתפוצות.

export function LandingPagesPage() {
  useDocumentTitle('דפי נחיתה');
  const toast = useToast();
  const qc = useQueryClient();
  const pagesQ = useQuery({ queryKey: ['landing-pages'], queryFn: fetchLandingPages });
  const [editing, setEditing] = useState<LandingPageRow | 'new' | null>(null);

  const action = useMutation({
    mutationFn: postLandingPageAction,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['landing-pages'] });
      toast.success('נשמר');
      setEditing(null);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const pages = pagesQ.data?.pages ?? [];

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">דפי נחיתה</h1>
        <button type="button" className="kf-btn kf-btn-primary" onClick={() => setEditing('new')}>
          + דף נחיתה חדש
        </button>
      </header>

      <PageIntro>
        דף נחיתה קליל שחי בתוך המערכת: כותרת, טקסט וטופס הרשמה. כל הרשמה נכנסת
        ישר ללידים עם הקמפיין של הדף — מוכן לסינון ולתפוצות. הקישור הציבורי:
        {' '}<code dir="ltr">/api/lp/&#123;slug&#125;</code>
      </PageIntro>

      {pagesQ.isLoading ? (
        <p className="text-slate-500">טוען…</p>
      ) : pages.length === 0 ? (
        <div className="kf-card p-8 text-center text-slate-500">
          עוד אין דפי נחיתה. צרו את הראשון — לוקח דקה.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {pages.map((p) => (
            <div key={p.id} className="kf-card space-y-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <strong>{p.title}</strong>
                <span className={p.active
                  ? 'rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700'
                  : 'rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500'}>
                  {p.active ? 'פעיל' : 'כבוי'}
                </span>
              </div>
              <div className="text-sm text-slate-600">{p.headline}</div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <code dir="ltr" className="rounded bg-slate-100 px-1.5 py-0.5">/api/lp/{p.slug}</code>
                <span>קמפיין: <code dir="ltr">{p.campaign}</code></span>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <a className="kf-btn text-xs" href={`/api/lp/${p.slug}`} target="_blank" rel="noreferrer">
                  פתח דף ↗
                </a>
                <a className="kf-btn text-xs" href={`/leads?source=${encodeURIComponent(p.source)}`}>
                  לידים מהדף
                </a>
                <button type="button" className="kf-btn text-xs" onClick={() => setEditing(p)}>עריכה</button>
                <button
                  type="button"
                  className="kf-btn text-xs"
                  onClick={() => action.mutate({ action: 'update', id: p.id, active: !p.active })}
                >
                  {p.active ? 'כיבוי' : 'הפעלה'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing ? (
        <LandingPageDialog
          page={editing === 'new' ? null : editing}
          busy={action.isPending}
          onSubmit={(payload) => {
            if (editing === 'new') {
              action.mutate({ action: 'create', ...payload });
            } else {
              const { slug: _slug, ...patch } = payload;
              action.mutate({ action: 'update', id: editing.id, ...patch });
            }
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function LandingPageDialog({
  page,
  busy,
  onSubmit,
  onCancel,
}: {
  page: LandingPageRow | null;
  busy: boolean;
  onSubmit: (payload: { slug: string; title: string; headline: string; subheadline?: string;
    body_md?: string; cta_label?: string; campaign: string }) => void;
  onCancel: () => void;
}) {
  const [slug, setSlug] = useState(page?.slug ?? '');
  const [title, setTitle] = useState(page?.title ?? '');
  const [headline, setHeadline] = useState(page?.headline ?? '');
  const [subheadline, setSubheadline] = useState(page?.subheadline ?? '');
  const [bodyMd, setBodyMd] = useState(page?.body_md ?? '');
  const [ctaLabel, setCtaLabel] = useState(page?.cta_label ?? 'רוצה שיחזרו אליי');
  const [campaign, setCampaign] = useState(page?.campaign ?? '');

  const slugValid = /^[a-z0-9-]{2,60}$/.test(slug);
  const canSave = slugValid && title.trim() && headline.trim() && campaign.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">{page ? 'עריכת דף נחיתה' : 'דף נחיתה חדש'}</h2>
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="text-slate-600">כתובת (slug)</span>
              <input className="kf-input mt-1 w-full" dir="ltr" value={slug} disabled={!!page}
                onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="webinar-august" />
              {slug && !slugValid ? (
                <span className="text-xs text-rose-600">אותיות קטנות באנגלית, ספרות ומקפים</span>
              ) : null}
            </label>
            <label className="text-sm">
              <span className="text-slate-600">קמפיין (source_campaign ללידים)</span>
              <input className="kf-input mt-1 w-full" dir="ltr" value={campaign}
                onChange={(e) => setCampaign(e.target.value)} placeholder="webinar_august_2026" />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-slate-600">שם הדף (פנימי + כותרת דפדפן)</span>
            <input className="kf-input mt-1 w-full" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">כותרת ראשית</span>
            <input className="kf-input mt-1 w-full" value={headline} onChange={(e) => setHeadline(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">כותרת משנה (אופציונלי)</span>
            <input className="kf-input mt-1 w-full" value={subheadline} onChange={(e) => setSubheadline(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">טקסט הדף (שורות ריקות = פסקאות, ** להדגשה, - לרשימה)</span>
            <textarea className="kf-input mt-1 w-full" rows={5} value={bodyMd} onChange={(e) => setBodyMd(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">טקסט הכפתור</span>
            <input className="kf-input mt-1 w-full" value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="kf-btn kf-btn-ghost" onClick={onCancel}>ביטול</button>
          <button
            type="button"
            className="kf-btn kf-btn-primary"
            disabled={!canSave || busy}
            onClick={() => onSubmit({
              slug,
              title: title.trim(),
              headline: headline.trim(),
              subheadline: subheadline.trim() || undefined,
              body_md: bodyMd.trim() || undefined,
              cta_label: ctaLabel.trim() || undefined,
              campaign: campaign.trim(),
            })}
          >
            {busy ? 'שומר…' : 'שמירה'}
          </button>
        </div>
      </div>
    </div>
  );
}
