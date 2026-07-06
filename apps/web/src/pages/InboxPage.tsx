import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { fetchAttentionInbox, postAdminAction, postQueueResolve } from '@/lib/api';
import { HeatBadge, MemberBadge, OwnershipBadge, StatusBadge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { formatRelative, PRODUCT_LABELS } from '@/lib/format';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import type { AttentionRow } from '@/lib/types';

type WorkLane = 'all' | 'reply' | 'call' | 'risk' | 'ops';

const WHATSAPP_FREEFORM_WINDOW_HOURS = 24;
const WHATSAPP_FREEFORM_WINDOW_MS = WHATSAPP_FREEFORM_WINDOW_HOURS * 60 * 60 * 1000;

const LANE_FILTERS: Array<{ key: WorkLane; label: string; hint: string }> = [
  { key: 'all', label: 'הכל', hint: 'כל מה שדורש טיפול' },
  { key: 'reply', label: 'לענות עכשיו', hint: 'לקוחות שממתינים למענה אנושי' },
  { key: 'call', label: 'להתקשר', hint: 'בקשות שיחה ולידים חמים' },
  { key: 'risk', label: 'בעיה/סיכון', hint: 'איחורים, תקלות ודברים שעלולים ליפול' },
  { key: 'ops', label: 'מעקב', hint: 'בדיקה, תשלום, מעקב וסגירות' },
];

const CLOSE_NOTE_TEMPLATES = [
  'טופל בוואטסאפ — אין צורך בפעולה נוספת כרגע.',
  'נקבעה שיחת טלפון להמשך טיפול.',
  'הועבר לנציג אנושי להמשך טיפול.',
  'הוחזר ל-AI — אין צורך במענה אנושי כרגע.',
  'לא רלוונטי / ביקש לא לפנות — לסמן כאבוד או DNC בכרטיס הליד.',
];

export function InboxPage() {
  useDocumentTitle('היום שלי');
  const [searchParams, setSearchParams] = useSearchParams();
  const initialLane = parseLane(searchParams.get('lane'));
  const [lane, setLane] = useState<WorkLane>(initialLane);
  const [pendingClose, setPendingClose] = useState<AttentionRow | null>(null);
  const [pendingNoAnswer, setPendingNoAnswer] = useState<AttentionRow | null>(null);
  const [closeNote, setCloseNote] = useState('');
  const [copiedTalkTrackId, setCopiedTalkTrackId] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const q = useQuery({
    queryKey: ['attention-inbox'],
    queryFn: () => fetchAttentionInbox(),
    refetchInterval: 30_000,
  });

  const allRows = useMemo(() => sortRows(q.data ?? []), [q.data]);
  const rows = useMemo(() => (
    lane === 'all' ? allRows : allRows.filter((row) => classifyRow(row).lane === lane)
  ), [allRows, lane]);

  const counts = useMemo(() => {
    const acc: Record<WorkLane, number> = { all: allRows.length, reply: 0, call: 0, risk: 0, ops: 0 };
    for (const row of allRows) acc[classifyRow(row).lane] += 1;
    return acc;
  }, [allRows]);

  const resolve = useMutation({
    mutationFn: (input: { queueItemId: string; note?: string | null }) =>
      postQueueResolve({ queueItemId: input.queueItemId, resolutionNote: input.note ?? null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['attention-inbox'] });
      qc.invalidateQueries({ queryKey: ['queue'] });
      toast.success('המשימה נסגרה');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const logNoAnswer = useMutation({
    mutationFn: (row: AttentionRow) =>
      postAdminAction({
        action: 'log_phone_call',
        leadId: row.lead_id,
        callOutcome: 'no_answer',
        callDurationMinutes: 0,
        note: 'סומן אין מענה מתוך היום שלי',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['attention-inbox'] });
      toast.success('נרשם ניסיון שיחה ללא מענה');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const urgent = allRows.filter((row) => classifyRow(row).urgency === 'critical').length;

  return (
    <div className="space-y-5">
      <header className="overflow-hidden rounded-3xl bg-gradient-to-l from-brand-700 via-brand-600 to-slate-900 p-5 text-white shadow-sm sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <p className="text-sm font-medium text-brand-100">עמדת עבודה יומית</p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">היום שלי</h1>
            <p className="max-w-2xl text-sm leading-6 text-brand-50/90">
              מתחילים מכאן: מי צריך טיפול עכשיו, למה הוא כאן, ומה הפעולה הבאה הכי נכונה.
              המטרה היא יום מכירות פשוט — פחות חיפוש, יותר שיחות וסגירות.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:min-w-[360px]">
            <Metric label="פתוח" value={allRows.length} />
            <Metric label="דחוף" value={urgent} tone={urgent > 0 ? 'danger' : 'ok'} />
            <Metric label="רענון" value="30ש׳" />
          </div>
        </div>
      </header>

      <InboxTrainingGuide />

      <DailyFocusPanel rows={allRows} />

      <section className="grid gap-3 md:grid-cols-5" aria-label="סינון משימות">
        {LANE_FILTERS.map((item) => {
          const active = lane === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setLane(item.key);
                const next = new URLSearchParams(searchParams);
                if (item.key === 'all') next.delete('lane');
                else next.set('lane', item.key);
                setSearchParams(next, { replace: true });
              }}
              aria-pressed={active}
              className={clsx(
                'rounded-2xl border p-4 text-start shadow-sm transition',
                active
                  ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-100'
                  : 'border-slate-200 bg-white hover:border-brand-200 hover:bg-slate-50',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={clsx('font-semibold', active ? 'text-brand-800' : 'text-slate-800')}>{item.label}</span>
                <span className={clsx(
                  'rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums',
                  active ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600',
                )}>{counts[item.key]}</span>
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500">{item.hint}</p>
            </button>
          );
        })}
      </section>

      <section className="space-y-3">
        {q.isLoading ? (
          <div className="kf-card p-10 text-center text-slate-500">טוען משימות...</div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="🎉"
            title="אין כרגע טיפול פתוח בקטגוריה הזו"
            hint="המסך מתרענן אוטומטית. אם נכנס ליד או שהלקוח ענה — הוא יופיע כאן."
          />
        ) : (
          rows.map((row) => {
            const meta = classifyRow(row);
            const plan = operatingPlan(row, meta);
            const chips = reasonChips(row, meta);
            const talkTrack = repTalkTrack(row, meta);
            const whatsappWindow = whatsappWindowStatus(row);
            const whatsappUrl = whatsappConversationUrl(row);
            return (
              <article
                key={`${row.kind}:${row.ref_id}`}
                className={clsx(
                  'kf-card overflow-hidden border-s-4 p-4 transition hover:shadow-md sm:p-5',
                  meta.borderClass,
                )}
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={clsx('rounded-full px-2.5 py-1 text-xs font-semibold', meta.pillClass)}>{meta.actionLabel}</span>
                      <span className="text-xs text-slate-500">{formatRelative(row.due_at ?? row.created_at)}</span>
                      {meta.urgency === 'critical' ? (
                        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">דחוף</span>
                      ) : null}
                    </div>

                    <div>
                      <Link to={`/leads/${row.lead_id}`} className="text-lg font-semibold text-slate-900 hover:text-brand-700 hover:underline">
                        {row.lead_name || `ליד ${row.lead_id.slice(0, 8)}`}
                      </Link>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
                        {row.lead_phone ? <a href={`tel:${row.lead_phone}`} className="tabular-nums hover:text-brand-700">{row.lead_phone}</a> : null}
                        <span>{humanReason(row)}</span>
                        {row.product_interest ? (
                          <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
                            {PRODUCT_LABELS[row.product_interest] ?? row.product_interest}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <div className="grid gap-2 rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-100 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                      <div>
                        <div className="text-xs font-semibold text-slate-500">פעולה הבאה</div>
                        <div className="mt-1 font-semibold text-slate-900">{plan.nextAction}</div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-slate-500">למה</div>
                        <div className="mt-1 text-sm leading-6 text-slate-700">{plan.why}</div>
                        {row.queue_summary && row.queue_summary !== plan.why ? (
                          <div className="mt-1 text-xs leading-5 text-slate-500">תקציר מערכת: {row.queue_summary}</div>
                        ) : null}
                      </div>
                    </div>

                    {chips.length ? (
                      <div className="flex flex-wrap gap-2" aria-label="סימני סיבה">
                        {chips.map((chip) => (
                          <span key={`${chip.label}:${chip.tone}`} className={clsx('rounded-full px-2.5 py-1 text-xs font-medium', chipClass(chip.tone))}>
                            {chip.label}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    {whatsappWindow ? (
                      <div className={clsx('rounded-2xl border p-3 text-sm leading-6', whatsappWindow.className)}>
                        <div className="font-semibold">{whatsappWindow.title}</div>
                        <div className="mt-1">{whatsappWindow.hint}</div>
                      </div>
                    ) : null}

                    <div className="rounded-2xl border border-brand-100 bg-brand-50/60 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs font-semibold text-brand-700">מה להגיד עכשיו</div>
                        <button
                          type="button"
                          className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-100 transition hover:bg-brand-50"
                          onClick={() => {
                            void copyTalkTrack(talkTrack).then(() => {
                              setCopiedTalkTrackId(row.ref_id);
                              window.setTimeout(() => setCopiedTalkTrackId((current) => (current === row.ref_id ? null : current)), 1800);
                            });
                          }}
                        >
                          {copiedTalkTrackId === row.ref_id ? 'הועתק' : 'העתקת נוסח'}
                        </button>
                      </div>
                      <p className="mt-1 text-sm leading-6 text-slate-800">{talkTrack}</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <MemberBadge isMember={row.is_program_member} />
                      <StatusBadge status={row.lead_status} />
                      <HeatBadge heat={row.lead_heat} />
                      <OwnershipBadge ownership={row.ownership_mode} />
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">עדיפות {row.priority_level}</span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 sm:min-w-[220px] sm:flex-row lg:flex-col">
                    <Link to={`/leads/${row.lead_id}`} className="kf-btn justify-center">
                      פתיחת ליד
                    </Link>
                    {row.lead_phone && meta.lane === 'call' ? (
                      <a
                        href={`tel:${row.lead_phone}`}
                        className="kf-btn kf-btn-ghost justify-center"
                        aria-label={`חיוג אל ${row.lead_name || row.lead_phone}`}
                      >
                        חיוג עכשיו
                      </a>
                    ) : null}
                    {row.lead_phone && meta.lane === 'call' ? (
                      <button
                        type="button"
                        className="kf-btn kf-btn-ghost justify-center"
                        disabled={logNoAnswer.isPending}
                        onClick={() => setPendingNoAnswer(row)}
                      >
                        סימון אין מענה
                      </button>
                    ) : null}
                    {whatsappUrl ? (
                      <a
                        href={whatsappUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="kf-btn kf-btn-ghost justify-center"
                        aria-label={`פתיחת WhatsApp עבור ${row.lead_name || row.lead_phone || 'הליד'}`}
                      >
                        פתיחת WhatsApp
                      </a>
                    ) : null}
                    {row.kind === 'queue' ? (
                      <button
                        type="button"
                        className="kf-btn kf-btn-ghost justify-center"
                        disabled={resolve.isPending}
                        onClick={() => {
                          setPendingClose(row);
                          setCloseNote('');
                        }}
                      >
                        סגירת משימה
                      </button>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })
        )}
      </section>

      <ConfirmDialog
        open={!!pendingNoAnswer}
        title="סימון אין מענה"
        description={pendingNoAnswer ? `לרשום ניסיון שיחה ללא מענה עבור ${pendingNoAnswer.lead_name || 'הליד'}?` : 'נרשום ניסיון שיחה ללא מענה.'}
        confirmLabel="רישום אין מענה"
        busy={logNoAnswer.isPending}
        onCancel={() => setPendingNoAnswer(null)}
        onConfirm={() => {
          if (!pendingNoAnswer) return;
          logNoAnswer.mutate(pendingNoAnswer);
          setPendingNoAnswer(null);
        }}
      />

      <ConfirmDialog
        open={!!pendingClose}
        title="סגירת משימה"
        description={pendingClose ? humanReason(pendingClose) : 'ניתן להוסיף הערה קצרה לסגירה.'}
        confirmLabel="סגירה"
        busy={resolve.isPending}
        onCancel={() => setPendingClose(null)}
        onConfirm={() => {
          if (!pendingClose) return;
          const note = closeNote.trim();
          resolve.mutate({ queueItemId: pendingClose.ref_id, note: note.length ? note : null });
          setPendingClose(null);
        }}
      >
        <div className="mb-3 flex flex-wrap gap-2">
          {CLOSE_NOTE_TEMPLATES.map((template) => (
            <button
              key={template}
              type="button"
              className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700 transition hover:bg-brand-50 hover:text-brand-700"
              onClick={() => setCloseNote(template)}
            >
              {template}
            </button>
          ))}
        </div>
        <label className="block text-sm">
          <span className="text-slate-600">הערת סגירה</span>
          <textarea
            className="kf-input mt-1 min-h-[72px]"
            placeholder="לדוגמה: טופל בוואטסאפ, נקבעה שיחה, לא רלוונטי..."
            value={closeNote}
            onChange={(e) => setCloseNote(e.target.value.slice(0, 500))}
            maxLength={500}
          />
        </label>
      </ConfirmDialog>
    </div>
  );
}

// Dismissible via localStorage. After day 3 the same training card
// reads as noise; Tier 5.B audit flagged it. Once dismissed, never
// re-shown for this user/browser (intentional — re-show would be
// patronising).
const INBOX_GUIDE_DISMISSED_KEY = 'karnaf_inbox_guide_dismissed_v1';

function InboxTrainingGuide() {
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(INBOX_GUIDE_DISMISSED_KEY) === '1';
  });
  if (dismissed) return null;

  function dismiss() {
    try { window.localStorage.setItem(INBOX_GUIDE_DISMISSED_KEY, '1'); }
    catch { /* private mode etc — accept the loss */ }
    setDismissed(true);
  }

  return (
    <section className="kf-card relative p-4 sm:p-5" aria-label="איך לעבוד במסך לטיפול עכשיו">
      <button
        type="button"
        onClick={dismiss}
        className="absolute left-3 top-3 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        aria-label="הסתר את ההדרכה"
        title="הסתר"
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path strokeLinecap="round" d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">הדרך הקצרה לעבודה נכונה</p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">פותחים כרטיס, מטפלים, וסוגרים — בלי לחפש ידנית.</h2>
          <p className="mt-1 text-sm leading-6 text-slate-500">
            המסך הזה הוא נקודת ההתחלה של עובד. אם משהו דורש אדם, הוא יופיע כאן עם סיבה ופעולה מומלצת.
          </p>
        </div>
        <div className="grid gap-2 text-sm sm:grid-cols-3 lg:min-w-[560px]">
          <TrainingStep number="1" title="לטפל לפי דחיפות" text="מתחילים מבעיה/סיכון ולענות עכשיו, ואז עוברים לשיחות ומעקב." />
          <TrainingStep number="2" title="פותחים את הליד" text="בכרטיס הליד יש פעולה הבאה, למה זה כאן, ומה להגיד ללקוח." />
          <TrainingStep number="3" title="סוגרים נכון" text="טופל = הלקוח קיבל מענה, הוחזר ל-AI, עבר לנציג/שיחה, או נסגר כלא רלוונטי/DNC בכרטיס הליד." />
        </div>
      </div>
    </section>
  );
}

// Tier 6.C — DailyFocusPanel slimmed. Before: 1 hero card ("הדבר
// הראשון לפתוח") + 3 metric tiles (דחוף/לענות/להתקשר). The 3 metrics
// already appear as count pills inside LANE_FILTERS below — two rows
// teaching the same numbers. Now: just the hero, full width.
function DailyFocusPanel({ rows }: { rows: AttentionRow[] }) {
  const firstRow = rows[0] ?? null;
  const firstMeta = firstRow ? classifyRow(firstRow) : null;
  const first = firstRow && firstMeta ? operatingPlan(firstRow, firstMeta) : null;

  return (
    <section className="kf-card border-s-4 border-s-brand-500 p-4" aria-label="מיקוד יומי">
      <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">הדבר הראשון לפתוח</p>
      {first ? (
        <>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-900">{first.nextAction}</h2>
            {firstMeta ? <span className={clsx('rounded-full px-2 py-0.5 text-xs font-semibold', firstMeta.pillClass)}>{firstMeta.actionLabel}</span> : null}
          </div>
          {firstRow ? (
            <Link to={`/leads/${firstRow.lead_id}`} className="mt-1 inline-flex text-sm font-semibold text-brand-700 hover:underline">
              לפתוח ראשון: {firstRow.lead_name || `ליד ${firstRow.lead_id.slice(0, 8)}`}
            </Link>
          ) : null}
          <p className="mt-1 text-sm leading-6 text-slate-500">{first.why}</p>
        </>
      ) : (
        <>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">אין כרגע טיפול דחוף</h2>
          <p className="mt-1 text-sm leading-6 text-slate-500">אפשר לעבור ללידים חדשים, פולואפים או שיפור נתונים.</p>
        </>
      )}
    </section>
  );
}

type ReasonChip = { label: string; tone: 'danger' | 'warning' | 'info' | 'success' | 'neutral' };

function reasonChips(row: AttentionRow, meta = classifyRow(row)): ReasonChip[] {
  const chips: ReasonChip[] = [];
  const dueMs = row.due_at ? Date.parse(row.due_at) : NaN;
  if (Number.isFinite(dueMs)) {
    const deltaMinutes = Math.round((Date.now() - dueMs) / 60_000);
    if (deltaMinutes > 0) chips.push({ label: `באיחור ${formatDuration(deltaMinutes)}`, tone: 'danger' });
    else if (deltaMinutes > -120) chips.push({ label: `לטיפול בקרוב`, tone: 'warning' });
  }
  if (row.priority_level <= 1) chips.push({ label: 'עדיפות גבוהה', tone: 'danger' });
  if (row.lead_heat === 'hot') chips.push({ label: 'ליד חם', tone: 'success' });
  if (row.intake_segment === 'hot_sales') chips.push({ label: 'מכירה חמה', tone: 'success' });
  if (row.intake_segment === 'support_or_existing') chips.push({ label: 'לקוח/תמיכה', tone: 'warning' });
  const whatsappWindow = whatsappWindowStatus(row);
  if (whatsappWindow?.state === 'open') chips.push({ label: 'WhatsApp פתוח', tone: 'success' });
  if (whatsappWindow?.state === 'closed') chips.push({ label: 'WhatsApp מחוץ ל-24ש׳', tone: 'warning' });
  if (row.queue_type) chips.push({ label: queueTypeLabel(row.queue_type), tone: queueTypeTone(row.queue_type) });
  if (meta.lane === 'reply') chips.push({ label: 'מחכה למענה אנושי', tone: 'warning' });
  if (meta.lane === 'call') chips.push({ label: 'צריך שיחה', tone: 'info' });
  if (meta.lane === 'risk') chips.push({ label: 'סיכון נפילה', tone: 'danger' });
  if (row.product_interest) chips.push({ label: PRODUCT_LABELS[row.product_interest] ?? row.product_interest, tone: 'neutral' });
  return dedupeChips(chips).slice(0, 6);
}

function dedupeChips(chips: ReasonChip[]): ReasonChip[] {
  const seen = new Set<string>();
  return chips.filter((chip) => {
    if (seen.has(chip.label)) return false;
    seen.add(chip.label);
    return true;
  });
}

function chipClass(tone: ReasonChip['tone']) {
  switch (tone) {
    case 'danger': return 'bg-rose-50 text-rose-700 ring-1 ring-rose-100';
    case 'warning': return 'bg-amber-50 text-amber-700 ring-1 ring-amber-100';
    case 'info': return 'bg-sky-50 text-sky-700 ring-1 ring-sky-100';
    case 'success': return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100';
    default: return 'bg-slate-100 text-slate-700';
  }
}

function queueTypeLabel(queueType: string) {
  const labels: Record<string, string> = {
    failed_automation: 'כשל אוטומציה',
    ai_stuck: 'AI נתקע',
    human_handoff: 'העברה לאדם',
    manual_reply: 'תגובה ידנית',
    pending_manual_reply: 'תגובה ממתינה',
    payment_followup: 'מעקב תשלום',
    sales_call: 'שיחת מכירה',
  };
  return labels[queueType] ?? queueType.replace(/_/g, ' ');
}

function queueTypeTone(queueType: string): ReasonChip['tone'] {
  if (queueType.includes('failed') || queueType.includes('stuck')) return 'danger';
  if (queueType.includes('handoff') || queueType.includes('manual')) return 'warning';
  if (queueType.includes('call')) return 'info';
  return 'neutral';
}

function whatsappWindowStatus(row: AttentionRow): null | {
  state: 'open' | 'closed' | 'unknown';
  title: string;
  hint: string;
  className: string;
} {
  if (!isWhatsAppRelevant(row)) return null;
  if (!row.last_inbound_at) {
    return {
      state: 'unknown',
      title: 'סטטוס WhatsApp לא ידוע',
      hint: 'אין הודעת לקוח אחרונה במערכת. לפתוח את הליד ולבדוק את השיחה לפני שליחה.',
      className: 'border-slate-200 bg-slate-50 text-slate-700',
    };
  }
  const lastInboundMs = Date.parse(row.last_inbound_at);
  if (!Number.isFinite(lastInboundMs)) return null;
  const ageMs = Date.now() - lastInboundMs;
  if (ageMs <= WHATSAPP_FREEFORM_WINDOW_MS) {
    return {
      state: 'open',
      title: 'WhatsApp פתוח למענה חופשי',
      hint: `הלקוח כתב ב-${WHATSAPP_FREEFORM_WINDOW_HOURS} השעות האחרונות. אפשר לענות חופשי מתוך הכרטיס.`,
      className: 'border-emerald-100 bg-emerald-50 text-emerald-800',
    };
  }
  return {
    state: 'closed',
    title: 'WhatsApp מחוץ לחלון 24 שעות',
    hint: 'אפשר לכתוב ב-CRM, אבל ההודעה תישמר ותישלח רק כשהלקוח יענה שוב או אחרי אישור תבנית Meta בעברית.',
    className: 'border-amber-100 bg-amber-50 text-amber-800',
  };
}

function isWhatsAppRelevant(row: AttentionRow) {
  const reason = `${row.kind} ${row.reason ?? ''} ${row.queue_type ?? ''} ${row.queue_summary ?? ''} ${row.ownership_mode} ${row.lead_status}`.toLowerCase();
  return row.kind === 'mia_reply'
    || row.ownership_mode === 'mia_active'
    || row.lead_status === 'human_handoff'
    || reason.includes('whatsapp')
    || reason.includes('manual_reply')
    || reason.includes('pending_manual_reply')
    || reason.includes('וואטסאפ')
    || reason.includes('מענה');
}

function whatsappConversationUrl(row: AttentionRow): string | null {
  if (!row.lead_phone || !isWhatsAppRelevant(row)) return null;
  const normalized = normalizePhoneForWhatsApp(row.lead_phone);
  return normalized ? `https://wa.me/${normalized}` : null;
}

function normalizePhoneForWhatsApp(phone: string): string | null {
  const compact = phone.replace(/[^\d+]/g, '');
  if (compact.startsWith('+')) return compact.slice(1).replace(/\D/g, '') || null;
  const digits = compact.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) return digits.slice(2) || null;
  if (digits.startsWith('972')) return digits;
  if (digits.startsWith('0')) return `972${digits.slice(1)}`;
  return digits;
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} דק׳`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}ש׳ ${rest}דק׳` : `${hours}ש׳`;
}

// Tier 6.C — FocusMetric removed (was used only inside DailyFocusPanel,
// now slimmed down to the hero card. The lane filters below already
// expose counts per lane).

function TrainingStep({ number, title, text }: { number: string; title: string; text: string }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-100">
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-brand-600 text-xs font-semibold text-white">{number}</span>
        <span className="font-semibold text-slate-800">{title}</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-500">{text}</p>
    </div>
  );
}

function parseLane(value: string | null): WorkLane {
  return value === 'reply' || value === 'call' || value === 'risk' || value === 'ops' ? value : 'all';
}

function Metric({ label, value, tone }: { label: string; value: number | string; tone?: 'danger' | 'ok' }) {
  return (
    <div className="rounded-2xl bg-white/12 p-3 ring-1 ring-white/20 backdrop-blur">
      <div className="text-xs text-white/75">{label}</div>
      <div className={clsx('mt-1 text-2xl font-semibold tabular-nums', tone === 'danger' && 'text-rose-100', tone === 'ok' && 'text-emerald-100')}>
        {value}
      </div>
    </div>
  );
}

function classifyRow(row: AttentionRow): {
  lane: WorkLane;
  actionLabel: string;
  urgency: 'critical' | 'normal';
  pillClass: string;
  borderClass: string;
} {
  const reason = `${row.reason ?? ''} ${row.queue_type ?? ''} ${row.queue_summary ?? ''} ${row.lead_status} ${row.ownership_mode}`.toLowerCase();
  const dueMs = row.due_at ? Date.parse(row.due_at) : NaN;
  const overdue = row.kind === 'overdue_action' || (Number.isFinite(dueMs) && dueMs < Date.now());

  // Tier 0.C kinds — explicit dispatch BEFORE keyword fallbacks so the
  // sla-worker watchers route to the right lane regardless of free-text.
  if (row.kind === 'phone_overdue' || row.kind === 'phone_escalation') {
    return {
      lane: 'call', actionLabel: 'להתקשר עכשיו', urgency: 'critical',
      pillClass: 'bg-indigo-100 text-indigo-800', borderClass: 'border-s-indigo-500',
    };
  }
  if (row.kind === 'ai_stuck') {
    return {
      lane: 'risk', actionLabel: 'בדיקת תקלת AI', urgency: 'critical',
      pillClass: 'bg-rose-100 text-rose-800', borderClass: 'border-s-rose-500',
    };
  }
  if (row.kind === 'deal_stalled') {
    return {
      lane: 'risk', actionLabel: 'להזיז עסקה', urgency: row.priority_level <= 1 ? 'critical' : 'normal',
      pillClass: 'bg-amber-100 text-amber-800', borderClass: 'border-s-amber-500',
    };
  }
  if (row.kind === 'meeting_outcome_pending') {
    return {
      lane: 'ops', actionLabel: 'לסכם פגישה', urgency: 'normal',
      pillClass: 'bg-violet-100 text-violet-800', borderClass: 'border-s-violet-400',
    };
  }

  if (row.kind === 'mia_reply' || row.ownership_mode === 'mia_active' || row.lead_status === 'human_handoff') {
    return {
      lane: 'reply', actionLabel: 'לענות עכשיו', urgency: overdue ? 'critical' : 'normal',
      pillClass: 'bg-amber-100 text-amber-800', borderClass: 'border-s-amber-400',
    };
  }
  if (row.ownership_mode === 'phone_sales_pending' || reason.includes('phone') || reason.includes('call') || reason.includes('שיחה') || reason.includes('טלפון')) {
    return {
      lane: 'call', actionLabel: 'להתקשר', urgency: row.priority_level <= 1 ? 'critical' : 'normal',
      pillClass: 'bg-indigo-100 text-indigo-800', borderClass: 'border-s-indigo-400',
    };
  }
  if (overdue || reason.includes('sla') || reason.includes('failed') || reason.includes('תקלה') || reason.includes('כשל')) {
    return {
      lane: 'risk', actionLabel: 'לטפל בסיכון', urgency: 'critical',
      pillClass: 'bg-rose-100 text-rose-800', borderClass: 'border-s-rose-500',
    };
  }
  return {
    lane: 'ops', actionLabel: 'בדיקה / מעקב', urgency: 'normal',
    pillClass: 'bg-sky-100 text-sky-800', borderClass: 'border-s-sky-400',
  };
}

function humanReason(row: AttentionRow): string {
  if (row.queue_summary) return row.queue_summary;
  if (row.reason) return row.reason;
  if (row.kind === 'mia_reply') return 'הלקוח השיב ומחכה למענה אנושי';
  if (row.kind === 'overdue_action') return 'הפעולה הבאה באיחור';
  if (row.kind === 'deal_stalled') return 'עסקה פתוחה ללא פעילות זמן רב';
  if (row.kind === 'meeting_outcome_pending') return 'פגישה עברה ללא תיעוד תוצאה';
  if (row.kind === 'phone_overdue') return 'שיחת טלפון באיחור — עברו 24 שעות';
  if (row.kind === 'phone_escalation') return 'הוסלם לשיחת מכירה';
  if (row.kind === 'ai_stuck') return 'AI לא הגיב בזמן — נדרשת בדיקה';
  if (row.kind === 'queue') return 'משימה פתוחה לטיפול';
  return 'דורש בדיקה';
}

function operatingPlan(row: AttentionRow, meta = classifyRow(row)): { nextAction: string; why: string } {
  if (row.suggested_next_action?.trim()) {
    return { nextAction: row.suggested_next_action.trim(), why: humanReason(row) };
  }
  const product = row.product_interest ? PRODUCT_LABELS[row.product_interest] ?? row.product_interest : null;
  if (meta.lane === 'call') {
    return {
      nextAction: 'להתקשר ולסגור אבחון קצר',
      why: product ? `הליד מתאים ל-${product}; מטרת השיחה היא להבין התאמה וטווח זמן.` : 'יש אינדיקציה לבקשת שיחה או ליד חם שצריך מגע אנושי.',
    };
  }
  if (meta.lane === 'reply') {
    return {
      nextAction: 'לענות בוואטסאפ ולשאול שאלת אבחון אחת',
      why: product ? `הלקוח מחכה למענה אנושי סביב ${product}.` : 'הלקוח השיב ומחכה למענה אנושי.',
    };
  }
  if (meta.lane === 'risk') {
    return {
      nextAction: 'לפתוח את הליד ולבדוק למה הטיפול נתקע',
      why: humanReason(row),
    };
  }
  return {
    nextAction: 'לעשות בדיקת מצב קצרה ולהחליט המשך',
    why: product ? `יש ליד פתוח עם מוצר משוער: ${product}.` : humanReason(row),
  };
}

function repTalkTrack(row: AttentionRow, meta = classifyRow(row)): string {
  const firstName = firstNameFromLead(row.lead_name) ?? 'היי';
  const product = row.product_interest ? PRODUCT_LABELS[row.product_interest] ?? row.product_interest : null;
  if (meta.lane === 'call') {
    return product
      ? `${firstName}, ראיתי שפנית לגבי ${product}. אני רוצה להבין איפה אתה עומד היום ומה הכי חשוב לך לפתור, ואז אגיד אם זה בכלל מתאים.`
      : `${firstName}, ראיתי שביקשת שיחה. אני רוצה להבין בקצרה מה המטרה שלך ומה חסר לך כרגע כדי לדעת אם ואיך נכון לעזור.`;
  }
  if (meta.lane === 'reply') {
    return product
      ? `${firstName}, קיבלתי את ההודעה שלך לגבי ${product}. כדי לכוון אותך נכון — מה השלב שלך כרגע ומה הדבר שהכי תוקע אותך?`
      : `${firstName}, קיבלתי את ההודעה. כדי לא לתת תשובה כללית — מה הדבר המרכזי שאתה רוצה לפתור עכשיו?`;
  }
  if (meta.lane === 'risk') {
    return `${firstName}, אני בודק/ת שלא נפלנו על הטיפול שלך. אפשר לוודא רגע מה נשאר פתוח מבחינתך?`;
  }
  return product
    ? `${firstName}, אני עושה בדיקת מצב קצרה לגבי ${product}. מה הצעד הבא שהכי יעזור לך עכשיו?`
    : `${firstName}, אני עושה בדיקת מצב קצרה. מה הצעד הבא שהכי יעזור לך עכשיו?`;
}

function firstNameFromLead(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first || null;
}

async function copyTalkTrack(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function sortRows(rows: AttentionRow[]): AttentionRow[] {
  return [...rows].sort((a, b) => {
    const ac = classifyRow(a).urgency === 'critical' ? 0 : 1;
    const bc = classifyRow(b).urgency === 'critical' ? 0 : 1;
    if (ac !== bc) return ac - bc;
    if (a.priority_level !== b.priority_level) return a.priority_level - b.priority_level;
    return dateValue(a.due_at ?? a.created_at) - dateValue(b.due_at ?? b.created_at);
  });
}

function dateValue(value: string | null | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : Number.MAX_SAFE_INTEGER;
}
