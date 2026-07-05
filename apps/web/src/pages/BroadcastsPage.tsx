import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchBroadcasts,
  fetchBroadcastStats,
  postBroadcastAction,
  previewBroadcastSegment,
} from '@/lib/api';
import type { BroadcastSegment, BroadcastStatus } from '@/lib/types';
import { useToast } from '@/components/Toast';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { PageIntro } from '@/components/PageIntro';
import { useAuth } from '@/auth/auth-context';
import { SOURCE_LABELS, PRD_TRACK_LABELS } from '@/lib/format';

const STATUS_LABELS: Record<BroadcastStatus, string> = {
  draft: 'טיוטה',
  scheduled: 'מתוזמן',
  sending: 'בשליחה',
  sent: 'נשלח',
  canceled: 'בוטל',
  failed: 'נכשל',
};

const STATUS_TONE: Record<BroadcastStatus, string> = {
  draft: 'text-slate-500',
  scheduled: 'text-blue-600',
  sending: 'text-amber-600',
  sent: 'text-emerald-600',
  canceled: 'text-slate-400',
  failed: 'text-red-600',
};

// Meta throttles a fresh WhatsApp number to a low daily tier. Warn once a
// segment crosses this so an operator doesn't fire a broadcast the number
// can't clear in a day. See §7 of the broadcast handoff.
const RATE_WARN_THRESHOLD = 250;

export function BroadcastsPage() {
  useDocumentTitle('הודעות תפוצה');
  const toast = useToast();
  const qc = useQueryClient();
  const auth = useAuth();
  const canManage = auth.role === 'owner' || auth.role === 'admin' || auth.role === 'mia';

  const broadcastsQ = useQuery({ queryKey: ['broadcasts'], queryFn: fetchBroadcasts });
  const [creating, setCreating] = useState(false);
  const [openStatsId, setOpenStatsId] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['broadcasts'] });

  const create = useMutation({
    mutationFn: postBroadcastAction,
    onSuccess: () => { invalidate(); toast.success('נשמר'); setCreating(false); },
    onError: (err) => toast.error((err as Error).message),
  });
  const lifecycle = useMutation({
    mutationFn: postBroadcastAction,
    onSuccess: () => { invalidate(); toast.success('עודכן'); },
    onError: (err) => toast.error((err as Error).message),
  });

  const broadcasts = broadcastsQ.data ?? [];

  if (!canManage) {
    return (
      <div className="kf-card p-6 text-center text-slate-500">
        אין לך הרשאה לצפות בהודעות תפוצה. פנה למנהל המערכת.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">הודעות תפוצה</h1>
        <button type="button" className="kf-btn kf-btn-primary" onClick={() => setCreating(true)}>
          תפוצה חדשה
        </button>
      </header>

      <PageIntro>
        שליחת תבנית WhatsApp מאושרת לקבוצת לידים מסוננת לפי מקור, קמפיין או מסלול.
        התפוצה רצה בעדיפות נמוכה כדי לא לחסום את הבוט, ומכבדת אוטומטית לידים שסומנו
        "לא ליצור קשר". האנליטיקה מתעדכנת מנשלח → נמסר → נקרא.
      </PageIntro>

      {broadcastsQ.isLoading ? <p className="text-slate-500">טוען...</p> : null}
      {!broadcastsQ.isLoading && broadcasts.length === 0 ? (
        <p className="text-slate-500">אין תפוצות עדיין.</p>
      ) : null}

      <ul className="space-y-2">
        {broadcasts.map((b) => (
          <li key={b.id} className="kf-card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <strong className="text-sm">{b.name}</strong>
              <span className={`text-xs font-medium ${STATUS_TONE[b.status]}`}>{STATUS_LABELS[b.status]}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              <span>ערוץ: {b.channel === 'whatsapp' ? 'וואטסאפ' : 'מייל'}</span>
              {b.meta_template?.name ? <span>תבנית: <code className="font-mono">{b.meta_template.name}</code></span> : null}
              <span>{segmentSummary(b.segment)}</span>
              {b.scheduled_at ? <span>מתוזמן: {formatDateTime(b.scheduled_at)}</span> : null}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span className="text-slate-600">נמענים: {b.recipient_count}</span>
              <span className="text-emerald-600">נשלחו: {b.sent_count}</span>
              {b.skipped_count > 0 ? <span className="text-slate-400">דולגו: {b.skipped_count}</span> : null}
              {b.failed_count > 0 ? <span className="text-red-600">נכשלו: {b.failed_count}</span> : null}
            </div>
            {b.body_snapshot ? (
              <p className="mt-2 whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-sm leading-6">{b.body_snapshot}</p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-1">
              {(b.status === 'draft' || b.status === 'scheduled') ? (
                <button type="button" className="kf-btn text-xs" disabled={lifecycle.isPending}
                  onClick={() => lifecycle.mutate({ action: 'schedule', id: b.id })}>
                  {b.status === 'scheduled' ? 'שלח עכשיו' : 'תזמן לעכשיו'}
                </button>
              ) : null}
              {(b.status === 'draft' || b.status === 'scheduled' || b.status === 'sending') ? (
                <button type="button" className="kf-btn text-xs" disabled={lifecycle.isPending}
                  onClick={() => lifecycle.mutate({ action: 'cancel', id: b.id })}>
                  ביטול
                </button>
              ) : null}
              <button type="button" className="kf-btn kf-btn-ghost text-xs"
                onClick={() => setOpenStatsId(openStatsId === b.id ? null : b.id)}>
                {openStatsId === b.id ? 'סגור אנליטיקה' : 'אנליטיקה'}
              </button>
            </div>
            {openStatsId === b.id ? <BroadcastStatsView id={b.id} /> : null}
          </li>
        ))}
      </ul>

      {creating ? (
        <CreateDialog
          busy={create.isPending}
          onSubmit={(payload) => create.mutate({ action: 'create', ...payload })}
          onCancel={() => setCreating(false)}
        />
      ) : null}
    </div>
  );
}

function BroadcastStatsView({ id }: { id: string }) {
  const statsQ = useQuery({ queryKey: ['broadcast-stats', id], queryFn: () => fetchBroadcastStats(id) });
  if (statsQ.isLoading) return <p className="mt-2 text-xs text-slate-500">טוען אנליטיקה...</p>;
  const s = statsQ.data;
  if (!s) return null;
  const cells: Array<[string, number, string]> = [
    ['נמענים', s.total, 'text-slate-700'],
    ['ממתין', s.pending + s.queued, 'text-slate-500'],
    ['נשלח', s.sent, 'text-emerald-600'],
    ['נמסר', s.delivered, 'text-emerald-700'],
    ['נקרא', s.read, 'text-blue-600'],
    ['דולג', s.skipped, 'text-slate-400'],
    ['נכשל', s.failed, 'text-red-600'],
  ];
  return (
    <div className="mt-2 grid grid-cols-3 gap-2 rounded-md bg-slate-50 p-3 text-center sm:grid-cols-7">
      {cells.map(([label, value, tone]) => (
        <div key={label}>
          <div className={`text-lg font-semibold ${tone}`}>{value}</div>
          <div className="text-xs text-slate-500">{label}</div>
        </div>
      ))}
    </div>
  );
}

interface CreatePayload {
  name: string;
  channel?: 'whatsapp';
  meta_template: { name: string; lang: string; params?: Array<{ name: string; value: string }> };
  body_snapshot?: string | null;
  segment: BroadcastSegment;
  scheduled_at?: string | null;
}

function CreateDialog({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (payload: CreatePayload) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [templateName, setTemplateName] = useState('webinar_launch_reminder');
  const [lang, setLang] = useState('he');
  const [zoomLink, setZoomLink] = useState('');
  const [body, setBody] = useState('');
  const [segSource, setSegSource] = useState('');
  const [segTrack, setSegTrack] = useState('');
  const [segCampaign, setSegCampaign] = useState('launch_webinar_2026');
  const [scheduleMode, setScheduleMode] = useState<'now' | 'later'>('now');
  const [scheduleAt, setScheduleAt] = useState('');

  const segment = useMemo<BroadcastSegment>(() => {
    const s: BroadcastSegment = {};
    if (segSource) s.source = segSource;
    if (segTrack) s.primary_track = segTrack;
    if (segCampaign.trim()) s.source_campaign = segCampaign.trim();
    return s;
  }, [segSource, segTrack, segCampaign]);

  const previewQ = useQuery({
    queryKey: ['broadcast-preview', segment],
    queryFn: () => previewBroadcastSegment(segment),
  });
  const count = previewQ.data ?? 0;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!templateName.trim()) return;
    const params = zoomLink.trim() ? [{ name: 'zoom_link', value: zoomLink.trim() }] : undefined;
    onSubmit({
      name: name.trim() || templateName.trim(),
      channel: 'whatsapp',
      meta_template: { name: templateName.trim(), lang, params },
      body_snapshot: body.trim() || null,
      segment,
      scheduled_at: scheduleMode === 'later' && scheduleAt ? new Date(scheduleAt).toISOString() : null,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <form className="kf-card max-h-[90vh] w-full max-w-xl space-y-3 overflow-auto p-5"
        onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">תפוצה חדשה</h2>

        <label className="block text-sm">
          <span className="text-slate-600">שם התפוצה (לשימוש פנימי)</span>
          <input className="kf-input mt-1" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="תזכורת וובינר השקה" />
        </label>

        <fieldset className="rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-xs font-medium text-slate-500">סגמנט</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-slate-600">קמפיין (source_campaign)</span>
              <input className="kf-input mt-1" value={segCampaign} onChange={(e) => setSegCampaign(e.target.value)}
                placeholder="launch_webinar_2026" />
            </label>
            <label className="block text-sm">
              <span className="text-slate-600">מקור</span>
              <select className="kf-input mt-1" value={segSource} onChange={(e) => setSegSource(e.target.value)}>
                <option value="">כל המקורות</option>
                {Object.entries(SOURCE_LABELS).map(([slug, label]) => (
                  <option key={slug} value={slug}>{label} ({slug})</option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-slate-600">מסלול</span>
              <select className="kf-input mt-1" value={segTrack} onChange={(e) => setSegTrack(e.target.value)}>
                <option value="">כל המסלולים</option>
                {Object.entries(PRD_TRACK_LABELS).map(([slug, label]) => (
                  <option key={slug} value={slug}>{label}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="mt-2 text-sm">
            <strong>{previewQ.isLoading ? '…' : count}</strong> נמענים זמינים
            <span className="text-xs text-slate-500"> (ללא DNC / מוסרים)</span>
          </p>
          {count > RATE_WARN_THRESHOLD ? (
            <p className="mt-1 text-xs text-amber-700">
              ⚠️ מעל {RATE_WARN_THRESHOLD} נמענים — מספר וואטסאפ חדש עשוי להיות מוגבל ל-{RATE_WARN_THRESHOLD}–1000 ביום.
              השליחה מווסתת אוטומטית, אבל ייתכן שהמסירה תתפרס על פני יותר מיום.
            </p>
          ) : null}
        </fieldset>

        <fieldset className="rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-xs font-medium text-slate-500">תבנית Meta מאושרת</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-slate-600">שם התבנית</span>
              <input className="kf-input mt-1 font-mono" required value={templateName}
                onChange={(e) => setTemplateName(e.target.value)} placeholder="webinar_launch_reminder" />
            </label>
            <label className="block text-sm">
              <span className="text-slate-600">שפה</span>
              <input className="kf-input mt-1" value={lang} onChange={(e) => setLang(e.target.value)} />
            </label>
          </div>
          <label className="mt-2 block text-sm">
            <span className="text-slate-600">קישור זום ({'{{1}}'} — רק אם התבנית כוללת משתנה)</span>
            <input className="kf-input mt-1" value={zoomLink} onChange={(e) => setZoomLink(e.target.value)}
              placeholder="https://zoom.us/j/..." />
          </label>
          <p className="mt-1 text-xs text-amber-700">
            שם ומספר המשתנים חייבים להתאים בדיוק לתבנית שאושרה ב-Meta (אחרת שגיאת #132000).
          </p>
        </fieldset>

        <label className="block text-sm">
          <span className="text-slate-600">נוסח לתצוגה מקדימה ב-CRM (לא נשלח — הלקוח מקבל את תבנית Meta)</span>
          <textarea className="kf-input mt-1 min-h-[80px] leading-6" value={body}
            onChange={(e) => setBody(e.target.value)} />
        </label>

        <fieldset className="rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-xs font-medium text-slate-500">תזמון</legend>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-1">
              <input type="radio" checked={scheduleMode === 'now'} onChange={() => setScheduleMode('now')} />
              שמור כטיוטה (תזמון מאוחר יותר)
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={scheduleMode === 'later'} onChange={() => setScheduleMode('later')} />
              מתוזמן לתאריך
            </label>
            {scheduleMode === 'later' ? (
              <input type="datetime-local" className="kf-input" value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)} />
            ) : null}
          </div>
        </fieldset>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="kf-btn" onClick={onCancel}>ביטול</button>
          <button type="submit" className="kf-btn kf-btn-primary" disabled={busy}>{busy ? 'שומר...' : 'שמירה'}</button>
        </div>
      </form>
    </div>
  );
}

function segmentSummary(segment: BroadcastSegment): string {
  const parts: string[] = [];
  if (segment.source_campaign) parts.push(`קמפיין: ${asText(segment.source_campaign)}`);
  if (segment.source) parts.push(`מקור: ${asText(segment.source)}`);
  if (segment.primary_track) parts.push(`מסלול: ${asText(segment.primary_track)}`);
  return parts.length ? parts.join(' · ') : 'כל הלידים';
}

function asText(v: string | string[]): string {
  return Array.isArray(v) ? v.join(', ') : v;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
}
