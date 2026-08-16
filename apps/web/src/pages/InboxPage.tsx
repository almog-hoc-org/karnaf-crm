import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { fetchAttentionInbox, postAdminAction, postQueueResolve, postSendReply, type LeadOutcome } from '@/lib/api';
import { ReplyComposer } from '@/components/ReplyComposer';
import { QuickClassifyPopover } from '@/components/QuickClassifyPopover';
import { SnoozePopover } from '@/components/SnoozePopover';
import { useAuth } from '@/auth/auth-context';
import { HeatBadge, MemberBadge, OwnershipBadge, StatusBadge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { describeLeadOrigin, formatRelative, PRODUCT_LABELS } from '@/lib/format';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import type { AttentionRow, IntakeSegment, LeadHeat } from '@/lib/types';

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

// Kinds whose ref_id is a real work_queue row — closable from here.
const QUEUE_BACKED_KINDS = new Set([
  'queue', 'ai_stuck', 'phone_overdue', 'phone_escalation', 'deal_stalled', 'meeting_outcome_pending',
]);

// "טיפול מיידי" = the customer replied to the bot and is waiting inside
// the 24h window (or an operator-set snooze popped). Everything else is
// follow-up work, rendered in a separate, calmer section — the inbox
// never again nags about a lead who wrote nothing.
const IMMEDIATE_KINDS = new Set(['mia_reply', 'awaiting_reply', 'snooze_due']);

function isImmediateRow(row: AttentionRow): boolean {
  return IMMEDIATE_KINDS.has(row.kind);
}

// Matches the exit half of --duration-exit on .kf-collapse / .kf-layer.
const CARD_EXIT_MS = 180;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return true; }
}

const OUTCOME_OPTIONS: Array<{ value: LeadOutcome; label: string }> = [
  { value: 'investor_mentorship', label: 'ליווי משקיעים' },
  { value: 'program', label: 'קורס הנדל"ן המקיף' },
  { value: 'consultation', label: 'פגישת ייעוץ' },
  { value: 'other', label: 'אחר (תיאור חופשי)' },
];

export function InboxPage() {
  useDocumentTitle('היום שלי');
  const [searchParams, setSearchParams] = useSearchParams();
  const initialLane = parseLane(searchParams.get('lane'));
  const [lane, setLane] = useState<WorkLane>(initialLane);
  const [pendingClose, setPendingClose] = useState<AttentionRow | null>(null);
  const [pendingOutcome, setPendingOutcome] = useState<AttentionRow | null>(null);
  const [outcomeChoice, setOutcomeChoice] = useState<LeadOutcome>('investor_mentorship');
  const [outcomeNote, setOutcomeNote] = useState('');
  const [pendingNoAnswer, setPendingNoAnswer] = useState<AttentionRow | null>(null);
  const [closeNote, setCloseNote] = useState('');
  const [copiedTalkTrackId, setCopiedTalkTrackId] = useState<string | null>(null);
  const [leavingLeadIds, setLeavingLeadIds] = useState<string[]>([]);
  // At most one inline composer open at a time — a dozen open textareas
  // would bury the card content this screen just fought to surface.
  const [replyOpenLeadId, setReplyOpenLeadId] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const auth = useAuth();
  // Mirrors the server-side gate on update_lead_meta (admin-actions).
  const canClassify = auth.role === 'owner' || auth.role === 'admin' || auth.role === 'mia';
  const navigate = useNavigate();
  // Keyboard triage: index into the rendered order (immediate then later).
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());

  const q = useQuery({
    queryKey: ['attention-inbox'],
    queryFn: () => fetchAttentionInbox(),
    // Paused while a composer is open: a refetch can drop or reorder the
    // card mid-typing and take the draft with it. The safety-net refetch
    // after every mutation still runs.
    refetchInterval: replyOpenLeadId ? false : 30_000,
    // Coming back to the tab is exactly when stale rows mislead.
    refetchOnWindowFocus: !replyOpenLeadId,
  });

  const [originFilter, setOriginFilter] = useState('');

  const allRows = useMemo(() => sortRows(q.data ?? []), [q.data]);
  const originOptions = useMemo(() => {
    const labels = new Set<string>();
    for (const row of allRows) labels.add(describeLeadOrigin(row).label);
    return Array.from(labels).sort((a, b) => a.localeCompare(b, 'he'));
  }, [allRows]);
  const rows = useMemo(() => {
    const byLane = lane === 'all' ? allRows : allRows.filter((row) => classifyRow(row).lane === lane);
    return originFilter ? byLane.filter((row) => describeLeadOrigin(row).label === originFilter) : byLane;
  }, [allRows, lane, originFilter]);
  const immediateRows = useMemo(() => rows.filter(isImmediateRow), [rows]);
  const laterRows = useMemo(() => rows.filter((row) => !isImmediateRow(row)), [rows]);

  const counts = useMemo(() => {
    const acc: Record<WorkLane, number> = { all: allRows.length, reply: 0, call: 0, risk: 0, ops: 0 };
    for (const row of allRows) acc[classifyRow(row).lane] += 1;
    return acc;
  }, [allRows]);

  // The exact order cards appear on screen — immediate section first.
  const visibleRows = useMemo(() => [...immediateRows, ...laterRows], [immediateRows, laterRows]);

  // Keyboard triage. event.code keeps the keys physical — on the Hebrew
  // layout the same fingers work without switching languages. Single-key
  // actions go through data-hotkey + .click() on the card's own buttons,
  // so every existing handler (dialogs, popovers, links) is reused as-is.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      if (pendingClose || pendingOutcome || pendingNoAnswer) return;
      if (!visibleRows.length) return;

      const move = (delta: number) => {
        e.preventDefault();
        setFocusedIdx((cur) => {
          const next = cur === null ? (delta > 0 ? 0 : visibleRows.length - 1)
            : Math.min(visibleRows.length - 1, Math.max(0, cur + delta));
          const row = visibleRows[next];
          const el = row ? cardRefs.current.get(`${row.kind}:${row.ref_id}`) : null;
          if (el) {
            el.focus({ preventScroll: true });
            el.scrollIntoView({ block: 'nearest' });
          }
          return next;
        });
      };

      if (e.code === 'KeyJ' || e.code === 'ArrowDown') { move(1); return; }
      if (e.code === 'KeyK' || e.code === 'ArrowUp') { move(-1); return; }

      const row = focusedIdx === null ? null : visibleRows[focusedIdx];
      if (!row) return;
      const card = cardRefs.current.get(`${row.kind}:${row.ref_id}`);
      const clickHotkey = (name: string) => {
        const el = card?.querySelector<HTMLElement>(`[data-hotkey="${name}"]`);
        if (!el) return;
        (el.matches('button, a') ? el : el.querySelector<HTMLElement>('button'))?.click();
      };

      if (e.code === 'Enter') { e.preventDefault(); navigate(`/leads/${row.lead_id}`); return; }
      if (e.code === 'KeyD') { e.preventDefault(); clickHotkey('done'); return; }
      if (e.code === 'KeyR') { e.preventDefault(); clickHotkey('reply'); return; }
      if (e.code === 'KeyS') { e.preventDefault(); clickHotkey('snooze'); return; }
      if (e.code === 'KeyW') { e.preventDefault(); clickHotkey('whatsapp'); return; }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visibleRows, focusedIdx, pendingClose, pendingOutcome, pendingNoAnswer, navigate]);

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

  // Quick-classify from the card. Classification does NOT remove the
  // card — the refreshed row updates the badges and chips in place.
  const classify = useMutation({
    mutationFn: (input: { leadId: string; metaUpdates: { lead_heat?: LeadHeat; intake_segment?: IntakeSegment } }) =>
      postAdminAction({ action: 'update_lead_meta', leadId: input.leadId, metaUpdates: input.metaUpdates }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['attention-inbox'] });
      toast.success('הסיווג עודכן');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  // Optimistic removal: acting on a card takes it off the list right
  // away; the refetch after the mutation settles is the safety net.
  // Clearing a lead is the action this screen exists for, so the card
  // fades and collapses on its way out and the ones below flow up —
  // without it the list snaps and you lose track of where you were.
  const removeLeadRows = (leadId: string) => {
    const drop = () => qc.setQueryData<AttentionRow[]>(
      ['attention-inbox'],
      (old) => (old ?? []).filter((r) => r.lead_id !== leadId),
    );
    if (prefersReducedMotion()) { drop(); return; }
    setLeavingLeadIds((prev) => (prev.includes(leadId) ? prev : [...prev, leadId]));
    window.setTimeout(() => {
      drop();
      setLeavingLeadIds((prev) => prev.filter((id) => id !== leadId));
    }, CARD_EXIT_MS);
  };
  const refetchInbox = () => qc.invalidateQueries({ queryKey: ['attention-inbox'] });

  // Inline reply — the whole reason the reply lane exists. Unlike the
  // triage mutations below, the card is removed only on SUCCESS: a failed
  // send must keep the card on screen and the draft in the composer.
  const sendInline = useMutation({
    mutationFn: (input: { row: AttentionRow; text: string }) =>
      postSendReply({
        leadId: input.row.lead_id,
        conversationId: input.row.last_inbound_conversation_id as string,
        text: input.text,
      }),
    onSuccess: (result, input) => {
      setReplyOpenLeadId(null);
      removeLeadRows(input.row.lead_id);
      void refetchInbox();
      if (result.warning) toast.info(result.warning);
      if (result.mode === 'sent_as_template') {
        toast.success('נשלח ללקוח כתבנית (מחוץ לחלון 24 שעות)');
      } else if (result.queued) {
        toast.success('ההודעה נשמרה ותישלח אוטומטית כשהלקוח יענה');
      } else {
        toast.success('הודעה נשלחה');
      }
    },
    onError: (err) => toast.error((err as Error).message),
  });


  const markReviewed = useMutation({
    mutationFn: (row: AttentionRow) =>
      postAdminAction({ action: 'mark_reviewed', leadId: row.lead_id, note: 'טופל מתוך היום שלי' }),
    onMutate: (row) => removeLeadRows(row.lead_id),
    onSuccess: () => { void refetchInbox(); toast.success('סומן כטופל — ירד מהתור'); },
    onError: (err) => { void refetchInbox(); toast.error((err as Error).message); },
  });

  const snoozeLead = useMutation({
    mutationFn: (input: { row: AttentionRow; until: string; note: string | null }) =>
      postAdminAction({ action: 'snooze_lead', leadId: input.row.lead_id, snoozeUntil: input.until, note: input.note }),
    onMutate: (input) => removeLeadRows(input.row.lead_id),
    onSuccess: (_res, input) => {
      void refetchInbox();
      toast.success(`הושהה עד ${new Date(input.until).toLocaleDateString('he-IL')} — יקפוץ חזרה בתאריך היעד`);
    },
    onError: (err) => { void refetchInbox(); toast.error((err as Error).message); },
  });

  const setOutcomeMut = useMutation({
    mutationFn: (input: { row: AttentionRow; outcome: LeadOutcome; note: string | null }) =>
      postAdminAction({ action: 'set_outcome', leadId: input.row.lead_id, outcome: input.outcome, outcomeNote: input.note }),
    onMutate: (input) => removeLeadRows(input.row.lead_id),
    onSuccess: () => { void refetchInbox(); toast.success('נרשמה תוצאה — הליד יצא מהתור הפעיל'); },
    onError: (err) => { void refetchInbox(); toast.error((err as Error).message); },
  });

  const noFollowup = useMutation({
    mutationFn: (row: AttentionRow) =>
      postAdminAction({ action: 'set_no_followup', leadId: row.lead_id, enabled: true }),
    onMutate: (row) => removeLeadRows(row.lead_id),
    onSuccess: () => { void refetchInbox(); toast.success('סומן: ללא פנייה יזומה בשלב הזה'); },
    onError: (err) => { void refetchInbox(); toast.error((err as Error).message); },
  });

  const urgent = allRows.filter((row) => classifyRow(row).urgency === 'critical').length;
  const immediateTotal = allRows.filter(isImmediateRow).length;

  const displayGroups = [
    {
      key: 'immediate',
      title: `טיפול מיידי — ענו וממתינים (${immediateRows.length})`,
      hint: 'לקוחות שכתבו לנו ומחכים — חלון ה-24 שעות רץ. זה התור החשוב.',
      rows: immediateRows,
      tone: 'hot' as const,
    },
    {
      key: 'later',
      title: `מעקב ותפעול — לא דחוף (${laterRows.length})`,
      hint: 'משימות המשך על לידים שכבר כתבו בעבר. אחרי שסיימתם את המענים.',
      rows: laterRows,
      tone: 'calm' as const,
    },
  ].filter((group) => group.rows.length > 0);

  return (
    <div className="space-y-4">
      <header className="overflow-hidden rounded-2xl bg-gradient-to-l from-brand-700 via-brand-600 to-slate-900 p-5 text-white shadow-sm sm:p-6">
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
            <Metric label="מיידי" value={immediateTotal} tone={immediateTotal > 0 ? 'danger' : 'ok'} />
            <Metric label="דחוף" value={urgent} tone={urgent > 0 ? 'danger' : 'ok'} />
            <Metric label="סה״כ פתוח" value={allRows.length} />
          </div>
        </div>
      </header>

      <InboxTrainingGuide />

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
                'kf-pressable kf-pressable-subtle rounded-xl border p-4 text-start shadow-sm transition',
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

      <p className="hidden text-xs text-slate-400 md:block" title="המקשים לפי מיקום פיזי במקלדת — עובדים גם בפריסת עברית">
        קיצורים: <kbd>J</kbd>/<kbd>K</kbd> ניווט בין כרטיסים · <kbd>Enter</kbd> פתיחת ליד · <kbd>D</kbd> טופל · <kbd>R</kbd> תשובה · <kbd>S</kbd> השהיה · <kbd>W</kbd> וואטסאפ
      </p>

      {originOptions.length > 1 ? (
        <section className="flex flex-wrap items-center gap-2" aria-label="סינון לפי מקור הגעה">
          <label htmlFor="inbox-origin-filter" className="text-sm font-medium text-slate-600">מקור הגעה:</label>
          <select
            id="inbox-origin-filter"
            className="kf-input max-w-[220px]"
            value={originFilter}
            onChange={(e) => setOriginFilter(e.target.value)}
          >
            <option value="">כל המקורות</option>
            {originOptions.map((label) => (
              <option key={label} value={label}>{label}</option>
            ))}
          </select>
          {originFilter ? (
            <button
              type="button"
              className="text-xs font-semibold text-brand-700 hover:underline"
              onClick={() => setOriginFilter('')}
            >
              ניקוי סינון
            </button>
          ) : null}
        </section>
      ) : null}

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
          displayGroups.map((group) => (
            <div key={group.key} className="space-y-3">
              <div className={clsx(
                'flex flex-wrap items-baseline justify-between gap-2 rounded-lg px-4 py-2 ring-1 ring-inset',
                group.tone === 'hot' ? 'kf-tone-danger' : 'kf-tone-neutral',
              )}>
                <h2 className="text-sm font-semibold">{group.title}</h2>
                <span className="text-xs opacity-80">{group.hint}</span>
              </div>
              {group.rows.map((row) => {
            const meta = classifyRow(row);
            const plan = operatingPlan(row, meta);
            const chips = reasonChips(row);
            const talkTrack = repTalkTrack(row, meta);
            const whatsappUrl = whatsappConversationUrl(row);
            const origin = describeLeadOrigin(row);
            const leaving = leavingLeadIds.includes(row.lead_id);
            // Inline reply: only where a human answer is what's due, and
            // only when the RPC gave us a real conversation to send into
            // (a pre-v5 backend or a text-less inbound degrades to the
            // wa.me link, which stays regardless).
            const canReplyInline =
              (row.kind === 'mia_reply' || row.kind === 'awaiting_reply') &&
              !!row.last_inbound_conversation_id;
            const replyOpen = canReplyInline && replyOpenLeadId === row.lead_id;
            return (
              <div key={`${row.kind}:${row.ref_id}`} className="kf-collapse" data-state={leaving ? 'closed' : 'open'}>
              <div>
              <article
                data-state={leaving ? 'closed' : 'open'}
                tabIndex={-1}
                ref={(el) => {
                  const key = `${row.kind}:${row.ref_id}`;
                  if (el) cardRefs.current.set(key, el);
                  else cardRefs.current.delete(key);
                }}
                className={clsx(
                  'kf-layer kf-layer-fade kf-card overflow-hidden border-s-4 p-4 transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 sm:p-5',
                  meta.borderClass,
                )}
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={clsx('rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset', meta.pillClass)}>{meta.actionLabel}</span>
                      <span className="text-xs text-slate-500">{formatRelative(row.due_at ?? row.created_at)}</span>
                      {meta.urgency === 'critical' ? (
                        <span className="kf-tone-danger rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset">דחוף</span>
                      ) : null}
                    </div>

                    <div>
                      <Link to={`/leads/${row.lead_id}`} className="text-lg font-semibold text-slate-900 hover:text-brand-700 hover:underline">
                        {row.lead_name || `ליד ${row.lead_id.slice(0, 8)}`}
                      </Link>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
                        {row.lead_phone ? <a href={`tel:${row.lead_phone}`} className="tabular-nums hover:text-brand-700">{row.lead_phone}</a> : null}
                        <span>{humanReason(row)}</span>
                        <span className="kf-chip kf-tone-neutral rounded-full">
                          מקור: {origin.label}{origin.detail ? ` · ${origin.detail}` : ''}
                        </span>
                        {row.product_interest ? (
                          <span className="kf-chip kf-tone-accent rounded-full">
                            {PRODUCT_LABELS[row.product_interest] ?? row.product_interest}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {/* The one coloured box left on the card. Everything
                        else that used to be boxed here — the plan, the
                        WhatsApp banner, the talk track — was competing
                        with the actual reason the card exists: what the
                        customer said. */}
                    {row.last_inbound_text ? (
                      <div className="kf-callout kf-tone-info">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs font-semibold">ההודעה האחרונה של הלקוח</div>
                          {row.last_inbound_at ? (
                            <span className="text-xs opacity-75">{formatRelative(row.last_inbound_at)}</span>
                          ) : null}
                        </div>
                        <p className="mt-1 whitespace-pre-wrap leading-6 text-slate-800">
                          ״{row.last_inbound_text}״
                        </p>
                      </div>
                    ) : null}

                    {canReplyInline ? (
                      replyOpen ? (
                        <div>
                          <div className="mb-1 flex items-center justify-between">
                            <span className="text-xs font-semibold text-brand-700">תשובה ללקוח</span>
                            <button
                              type="button"
                              className="text-xs text-slate-400 hover:text-slate-700"
                              onClick={() => setReplyOpenLeadId(null)}
                            >
                              סגירה
                            </button>
                          </div>
                          <ReplyComposer
                            compact
                            autoFocus
                            disabled={false}
                            channel={row.last_inbound_channel ?? 'whatsapp'}
                            lastInboundAt={row.last_inbound_at}
                            onSend={(text) => sendInline.mutateAsync({ row, text })}
                            sending={sendInline.isPending && sendInline.variables?.row.lead_id === row.lead_id}
                            errorMessage={null}
                          />
                        </div>
                      ) : (
                        <button
                          type="button"
                          data-hotkey="reply"
                          className="kf-btn kf-btn-primary w-full justify-center sm:w-auto"
                          onClick={() => setReplyOpenLeadId(row.lead_id)}
                        >
                          השב כאן 💬
                        </button>
                      )
                    ) : null}

                    {/* Plain text, no frame: this is the card's primary
                        content, and primary content doesn't need a box to
                        prove it. */}
                    <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
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
                          <span key={`${chip.label}:${chip.tone}`} className={clsx('kf-chip', toneClass(chip.tone))}>
                            {chip.label}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    {/* Collapsed by default. A suggested opening line is
                        useful on the card you are working, not on all
                        eleven of them at once. */}
                    <details className="group/talk">
                      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-semibold text-brand-700 hover:underline">
                        <span aria-hidden="true" className="transition group-open/talk:rotate-90">›</span>
                        <span>מה להגיד עכשיו</span>
                      </summary>
                      <div className="mt-2 flex items-start justify-between gap-3">
                        <p className="text-sm leading-6 text-slate-800">{talkTrack}</p>
                        <button
                          type="button"
                          className="kf-pressable shrink-0 rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-brand-700 ring-1 ring-inset ring-brand-200 transition hover:bg-brand-50"
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
                    </details>

                    <div className="flex flex-wrap items-center gap-2">
                      <MemberBadge isMember={row.is_program_member} />
                      <StatusBadge status={row.lead_status} />
                      <HeatBadge heat={row.lead_heat} />
                      <OwnershipBadge ownership={row.ownership_mode} />
                      <span className="kf-chip kf-tone-neutral">עדיפות {row.priority_level}</span>
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
                        data-hotkey="whatsapp"
                        className="kf-btn kf-btn-ghost justify-center"
                        aria-label={`פתיחת WhatsApp עבור ${row.lead_name || row.lead_phone || 'הליד'}`}
                      >
                        פתיחת WhatsApp
                      </a>
                    ) : null}
                    {QUEUE_BACKED_KINDS.has(row.kind) ? (
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
                    <button
                      type="button"
                      data-hotkey="done"
                      className="kf-btn justify-center bg-emerald-600 text-white hover:bg-emerald-700"
                      disabled={markReviewed.isPending}
                      onClick={() => markReviewed.mutate(row)}
                    >
                      טופל ✓
                    </button>
                    {/* The wrapper carries the hotkey target; the popover
                        owns its own button. */}
                    <span data-hotkey="snooze" className="contents">
                      <SnoozePopover
                        buttonClassName="kf-btn kf-btn-ghost w-full justify-center"
                        busy={snoozeLead.isPending}
                        onSnooze={(until, note) => snoozeLead.mutate({ row, until, note })}
                      />
                    </span>
                    {canClassify ? (
                      <QuickClassifyPopover
                        heat={row.lead_heat}
                        segment={row.intake_segment}
                        busy={classify.isPending}
                        buttonClassName="kf-btn kf-btn-ghost w-full justify-center"
                        onSetHeat={(heat) => classify.mutate({ leadId: row.lead_id, metaUpdates: { lead_heat: heat } })}
                        onSetSegment={(segment) => classify.mutate({ leadId: row.lead_id, metaUpdates: { intake_segment: segment } })}
                      />
                    ) : null}
                    <button
                      type="button"
                      className="kf-btn kf-btn-ghost justify-center"
                      onClick={() => {
                        setPendingOutcome(row);
                        setOutcomeChoice('investor_mentorship');
                        setOutcomeNote('');
                      }}
                    >
                      נסגר לתהליך 🏷
                    </button>
                    <button
                      type="button"
                      className="kf-btn kf-btn-ghost justify-center text-slate-500"
                      disabled={noFollowup.isPending}
                      onClick={() => noFollowup.mutate(row)}
                    >
                      ללא פנייה יזומה
                    </button>
                  </div>
                </div>
              </article>
              </div>
              </div>
            );
          })}
            </div>
          ))
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
              className="kf-pressable rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700 transition hover:bg-brand-50 hover:text-brand-700"
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

      <ConfirmDialog
        open={!!pendingOutcome}
        title={`נסגר לתהליך — ${pendingOutcome?.lead_name ?? ''}`}
        description="הליד יסומן בתוצאה, יירד מהתור הפעיל ויישאר ברשימת הלידים עם תג מסונן. סגירה לקורס/ליווי משקיעים גם מריצה את שרשרת הזכייה (עסקה, מסע, עמלות)."
        confirmLabel="שמירת תוצאה"
        busy={setOutcomeMut.isPending}
        onCancel={() => setPendingOutcome(null)}
        onConfirm={() => {
          if (!pendingOutcome) return;
          const note = outcomeNote.trim();
          if (outcomeChoice === 'other' && !note) return;
          setOutcomeMut.mutate({ row: pendingOutcome, outcome: outcomeChoice, note: note || null });
          setPendingOutcome(null);
        }}
      >
        <label className="block text-sm">
          <span className="text-slate-600">לאיזה תהליך נסגר?</span>
          <select
            className="kf-input mt-1 w-full"
            value={outcomeChoice}
            onChange={(e) => setOutcomeChoice(e.target.value as LeadOutcome)}
          >
            {OUTCOME_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="mt-3 block text-sm">
          <span className="text-slate-600">
            {outcomeChoice === 'other' ? 'תיאור (חובה)' : 'הערה (אופציונלי)'}
          </span>
          <textarea
            className="kf-input mt-1 min-h-[64px] w-full"
            maxLength={600}
            value={outcomeNote}
            onChange={(e) => setOutcomeNote(e.target.value)}
            placeholder={outcomeChoice === 'other' ? 'למשל: הופנה לשותף חיצוני' : ''}
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
          <p className="text-xs font-semibold text-brand-700">הדרך הקצרה לעבודה נכונה</p>
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

// The six tones from index.css. A chip states a fact about the row; the
// tone says what kind of fact it is, and it means the same thing here as
// it does on a badge, a callout or a toast.
type Tone = 'danger' | 'warning' | 'info' | 'success' | 'accent' | 'neutral';

function toneClass(tone: Tone) {
  return `kf-tone-${tone}`;
}

// Chips are capped at three. The old cap of six guaranteed a second row
// of pills under every card, and the first three were the ones anybody
// read — so the tail was pure noise. Ordered by what actually changes
// the operator's next move: lateness, then the WhatsApp window, then the
// queue reason.
//
// Dropped entirely: "מחכה למענה אנושי" / "צריך שיחה" / "סיכון נפילה",
// which restate the action pill at the top of the same card, and
// "עדיפות גבוהה", which restates the priority badge at the bottom of it.
function reasonChips(row: AttentionRow): ReasonChip[] {
  const chips: ReasonChip[] = [];
  const dueMs = row.due_at ? Date.parse(row.due_at) : NaN;
  if (Number.isFinite(dueMs)) {
    const deltaMinutes = Math.round((Date.now() - dueMs) / 60_000);
    // Only real lateness earns a chip. "לטיפול בקרוב" fired for anything
    // due within two hours, which is most of the board, and the due time
    // is already spelled out next to the action pill.
    if (deltaMinutes > 0) chips.push({ label: `באיחור ${formatDuration(deltaMinutes)}`, tone: 'danger' });
  }
  const whatsappWindow = whatsappWindowStatus(row);
  if (whatsappWindow?.state === 'open') chips.push({ label: 'WhatsApp פתוח', tone: 'success' });
  if (whatsappWindow?.state === 'closed') chips.push({ label: 'WhatsApp מחוץ ל-24ש׳', tone: 'warning' });
  if (row.queue_type) chips.push({ label: queueTypeLabel(row.queue_type), tone: queueTypeTone(row.queue_type) });
  // "ליד חם" and "מכירה חמה" are the same news from two fields; a hot
  // lead in the hot_sales segment used to get both chips.
  if (row.lead_heat === 'hot') chips.push({ label: 'ליד חם', tone: 'success' });
  else if (row.intake_segment === 'hot_sales') chips.push({ label: 'מכירה חמה', tone: 'success' });
  if (row.intake_segment === 'support_or_existing') chips.push({ label: 'לקוח/תמיכה', tone: 'warning' });
  return dedupeChips(chips).slice(0, 3);
}

type ReasonChip = { label: string; tone: Tone };

function dedupeChips(chips: ReasonChip[]): ReasonChip[] {
  const seen = new Set<string>();
  return chips.filter((chip) => {
    if (seen.has(chip.label)) return false;
    seen.add(chip.label);
    return true;
  });
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

function queueTypeTone(queueType: string): Tone {
  if (queueType.includes('failed') || queueType.includes('stuck')) return 'danger';
  if (queueType.includes('handoff') || queueType.includes('manual')) return 'warning';
  if (queueType.includes('call')) return 'info';
  return 'neutral';
}

// Was a full titled banner on every card, carrying its own colour
// vocabulary; it now feeds a single chip, because the chip row was
// already saying the same thing one line above it.
function whatsappWindowStatus(row: AttentionRow): null | { state: 'open' | 'closed' | 'unknown' } {
  if (!isWhatsAppRelevant(row)) return null;
  if (!row.last_inbound_at) return { state: 'unknown' };
  const lastInboundMs = Date.parse(row.last_inbound_at);
  if (!Number.isFinite(lastInboundMs)) return null;
  const ageMs = Date.now() - lastInboundMs;
  return { state: ageMs <= WHATSAPP_FREEFORM_WINDOW_MS ? 'open' : 'closed' };
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
    <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-inset ring-slate-200">
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
    <div className="rounded-xl bg-white/12 p-3 ring-1 ring-inset ring-white/20 backdrop-blur">
      <div className="text-xs text-white/75">{label}</div>
      <div className={clsx('mt-1 text-2xl font-semibold tabular-nums', tone === 'danger' && 'text-rose-100', tone === 'ok' && 'text-emerald-100')}>
        {value}
      </div>
    </div>
  );
}

// The left stripe answers "how urgent", not "what kind" — so it has
// three states, not the twelve colour/weight combinations it used to
// carry. Kind is already said by the action pill next to it, in words.
function classifyRow(row: AttentionRow): ClassifiedRow & { pillClass: string; borderClass: string } {
  const base = classifyRowBase(row);
  const borderClass =
    base.urgency === 'critical' ? 'border-s-rose-500' :
    base.lane === 'reply' ? 'border-s-amber-400' :
    'border-s-brand-400';
  return { ...base, pillClass: toneClass(base.tone), borderClass };
}

type ClassifiedRow = {
  lane: WorkLane;
  actionLabel: string;
  urgency: 'critical' | 'normal';
  tone: Tone;
};

function classifyRowBase(row: AttentionRow): ClassifiedRow {
  const reason = `${row.reason ?? ''} ${row.queue_type ?? ''} ${row.queue_summary ?? ''} ${row.lead_status} ${row.ownership_mode}`.toLowerCase();
  const dueMs = row.due_at ? Date.parse(row.due_at) : NaN;
  const overdue = row.kind === 'overdue_action' || (Number.isFinite(dueMs) && dueMs < Date.now());

  // Tier 0.C kinds — explicit dispatch BEFORE keyword fallbacks so the
  // sla-worker watchers route to the right lane regardless of free-text.
  if (row.kind === 'snooze_due') {
    return {
      lane: 'risk', actionLabel: 'חזר מהשהיה', urgency: 'normal', tone: 'accent',
    };
  }
  if (row.kind === 'phone_overdue' || row.kind === 'phone_escalation') {
    return {
      lane: 'call', actionLabel: 'להתקשר עכשיו', urgency: 'critical', tone: 'accent',
    };
  }
  if (row.kind === 'ai_stuck') {
    return {
      lane: 'risk', actionLabel: 'בדיקת תקלת AI', urgency: 'critical', tone: 'danger',
    };
  }
  if (row.kind === 'deal_stalled') {
    return {
      lane: 'risk', actionLabel: 'להזיז עסקה', urgency: row.priority_level <= 1 ? 'critical' : 'normal', tone: 'warning',
    };
  }
  if (row.kind === 'meeting_outcome_pending') {
    return {
      lane: 'ops', actionLabel: 'לסכם פגישה', urgency: 'normal', tone: 'accent',
    };
  }

  if (
    row.kind === 'awaiting_reply' ||
    row.kind === 'mia_reply' ||
    row.ownership_mode === 'mia_active' ||
    row.lead_status === 'human_handoff'
  ) {
    // A customer message is always due the moment it arrived, so plain
    // "overdue" made every reply-row critical. Escalate visually only
    // once the customer has waited more than 2 hours.
    const waitedOverTwoHours = Number.isFinite(dueMs) && Date.now() - dueMs > 2 * 60 * 60 * 1000;
    return {
      lane: 'reply', actionLabel: 'לענות עכשיו', urgency: waitedOverTwoHours ? 'critical' : 'normal', tone: 'warning',
    };
  }
  if (row.ownership_mode === 'phone_sales_pending' || reason.includes('phone') || reason.includes('call') || reason.includes('שיחה') || reason.includes('טלפון')) {
    return {
      lane: 'call', actionLabel: 'להתקשר', urgency: row.priority_level <= 1 ? 'critical' : 'normal', tone: 'accent',
    };
  }
  if (overdue || reason.includes('sla') || reason.includes('failed') || reason.includes('תקלה') || reason.includes('כשל')) {
    return {
      lane: 'risk', actionLabel: 'לטפל בסיכון', urgency: 'critical', tone: 'danger',
    };
  }
  return {
    lane: 'ops', actionLabel: 'בדיקה / מעקב', urgency: 'normal', tone: 'info',
  };
}

function humanReason(row: AttentionRow): string {
  if (row.queue_summary) return row.queue_summary;
  if (row.reason) return row.reason;
  if (row.kind === 'mia_reply') return 'הלקוח השיב ומחכה למענה אנושי';
  if (row.kind === 'awaiting_reply') return 'הלקוח כתב וטרם קיבל תשובה';
  if (row.kind === 'overdue_action') return 'הפעולה הבאה באיחור';
  if (row.kind === 'snooze_due') return 'חזר מהשהיה — הגיע מועד הבדיקה החוזרת';
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
    // Customers waiting for a reply come before everything else — a
    // human on the other end beats any internal ops item.
    const ar = classifyRow(a).lane === 'reply' ? 0 : 1;
    const br = classifyRow(b).lane === 'reply' ? 0 : 1;
    if (ar !== br) return ar - br;
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
