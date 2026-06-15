import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import clsx from 'clsx';
import {
  fetchAutomationRunsForContact,
  fetchJourneyRunsForContact,
  fetchLeadDetail,
  fetchMessageTemplates,
  postAdminAction,
  postLeadManage,
  postSendReply,
  postQueueResolve,
  type AdminAction,
  type CallOutcome,
  type LeadMetaUpdates,
  type ReopenTarget,
} from '@/lib/api';
import { contextFromLead, renderTemplate } from '@/lib/template-render';
import { HeatBadge, OwnershipBadge, StatusBadge } from '@/components/Badge';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LeadDetailSkeleton } from '@/components/Skeleton';
import { UnifiedTimeline } from '@/components/UnifiedTimeline';
import { t } from '@/lib/i18n';
import {
  AI_PLAYBOOK_STAGE_LABELS,
  COMMISSION_STATUS_LABELS,
  DEAL_STAGE_LABELS,
  DEAL_STATUS_LABELS,
  MEETING_STATUS_LABELS, MEETING_TYPE_LABELS,
  PARTNER_DOMAIN_LABELS,
  PRD_TRACK_LABELS,
  PROGRAM_PROGRESS_LABELS,
  QUEUE_LABELS,
  SOURCE_LABELS,
  labelOr,
  formatDateTime, formatRelative,
} from '@/lib/format';
import type {
  DealRow,
  IntakeSegment,
  InquiryType,
  LeadDetail as LeadDetailType,
  LeadFit,
  LeadHeat,
  MeetingRow,
  MessageRow,
  MessageTemplateRow,
  ProductInterest,
  ProgramMemberRow,
  QueueRow,
  ReadinessLevel,
} from '@/lib/types';
import { useAuth } from '@/auth/auth-context';
import { useToast } from '@/components/Toast';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';

export function LeadDetailPage() {
  const { leadId = '' } = useParams<{ leadId: string }>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const auth = useAuth();
  const toast = useToast();
  const detailQ = useQuery({
    queryKey: ['lead-detail', leadId],
    queryFn: () => fetchLeadDetail(leadId),
    enabled: !!leadId,
    // ⚠️ Live-update bug (2026-05-15): without polling, the lead detail
    // loaded ONCE on mount and never refreshed, so inbound WhatsApp messages
    // didn't appear until the operator clicked something else. 5s poll is
    // the floor; realtime invalidation below short-circuits it when a
    // change actually fires. refetchIntervalInBackground stays false so
    // hidden tabs don't burn quota.
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });

  useDocumentTitle(detailQ.data?.lead.full_name || 'ליד');

  // Live updates: subscribe to Postgres changes scoped to THIS lead so the
  // transcript / ownership / queue refreshes within ~1s of the inbound
  // landing in the DB. The filter keeps us from invalidating on every
  // other lead's messages in the same publication. Migration 029 adds the
  // required tables to `supabase_realtime`.
  const leadDetailKey: Array<readonly unknown[]> = [['lead-detail', leadId]];
  useRealtimeInvalidate('messages', leadDetailKey, { filter: `lead_id=eq.${leadId}` });
  useRealtimeInvalidate('leads', leadDetailKey, { filter: `id=eq.${leadId}` });
  useRealtimeInvalidate('work_queue', leadDetailKey, { filter: `lead_id=eq.${leadId}` });
  useRealtimeInvalidate('conversation_claims', leadDetailKey);

  const action = useMutation({
    mutationFn: (input: { action: AdminAction; note?: string; label: string; dealId?: string; targetStage?: string }) =>
      postAdminAction({
        action: input.action,
        leadId,
        note: input.note ?? null,
        dealId: input.dealId,
        targetStage: input.targetStage,
      }).then((r) => ({
        r,
        label: input.label,
      })),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['lead-detail', leadId] });
      toast.success(`${data.label} – בוצע`);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const logCall = useMutation({
    mutationFn: (input: { outcome: CallOutcome; durationMinutes: number; note: string | null }) =>
      postAdminAction({
        action: 'log_phone_call',
        leadId,
        callOutcome: input.outcome,
        callDurationMinutes: input.durationMinutes,
        note: input.note,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-detail', leadId] });
      toast.success('שיחת טלפון נרשמה');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const scheduleMeeting = useMutation({
    mutationFn: (input: {
      meetingType: MeetingRow['meeting_type'];
      startsAt: string;
      endsAt: string | null;
      summary: string | null;
      meetingUrl: string | null;
      dealId: string | null;
    }) =>
      postAdminAction({
        action: 'schedule_meeting',
        leadId,
        meetingType: input.meetingType,
        meetingStartsAt: input.startsAt,
        meetingEndsAt: input.endsAt,
        meetingSummary: input.summary,
        meetingUrl: input.meetingUrl,
        dealId: input.dealId,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-detail', leadId] });
      toast.success('הפגישה תועדה');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const updateMeetingStatus = useMutation({
    mutationFn: (input: { meetingId: string; status: MeetingRow['status']; note: string | null }) =>
      postAdminAction({
        action: 'update_meeting_status',
        leadId,
        meetingId: input.meetingId,
        meetingStatus: input.status,
        note: input.note,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-detail', leadId] });
      toast.success('סטטוס הפגישה עודכן');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const conversationId = detailQ.data?.conversations[0]?.id;

  const sendReply = useMutation({
    mutationFn: (text: string) => {
      if (!conversationId) throw new Error('No conversation');
      return postSendReply({ leadId, conversationId, text });
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['lead-detail', leadId] });
      if (result.queued) {
        toast.success('ההודעה נשמרה ותישלח אוטומטית כשהלקוח יענה');
        return;
      }
      toast.success('הודעה נשלחה');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const resolveQueue = useMutation({
    mutationFn: (input: { queueItemId: string; note?: string }) =>
      postQueueResolve({ queueItemId: input.queueItemId, resolutionNote: input.note ?? null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-detail', leadId] });
      toast.success('פריט תור נסגר');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const [pendingAction, setPendingAction] = useState<{
    action: AdminAction;
    note?: string;
    label: string;
    description: string;
    destructive: boolean;
  } | null>(null);
  const [pendingQueueClose, setPendingQueueClose] = useState<{ id: string; label: string } | null>(null);
  const [queueCloseNote, setQueueCloseNote] = useState('');
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenTarget, setReopenTarget] = useState<ReopenTarget>('responded');
  const [reopenNote, setReopenNote] = useState('');

  const reopen = useMutation({
    mutationFn: (input: { targetStatus: ReopenTarget; note: string | null }) =>
      postAdminAction({
        action: 'reopen_lead',
        leadId,
        targetStatus: input.targetStatus,
        note: input.note,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-detail', leadId] });
      toast.success('הליד נפתח מחדש');
      setReopenOpen(false);
      setReopenNote('');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteLead = useMutation({
    mutationFn: () => postLeadManage({ action: 'delete', leadId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      toast.success('הליד נמחק');
      setDeleteOpen(false);
      navigate('/leads');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const updateMeta = useMutation({
    mutationFn: (updates: LeadMetaUpdates) =>
      postAdminAction({ action: 'update_lead_meta', leadId, metaUpdates: updates }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-detail', leadId] });
      toast.success('עודכן');
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const canEditMeta = auth.role === 'owner' || auth.role === 'admin' || auth.role === 'mia';

  if (detailQ.isLoading) return <LeadDetailSkeleton />;
  if (detailQ.error)
    return (
      <p className="text-rose-600">
        {t('error_prefix')}: {(detailQ.error as Error).message}
      </p>
    );
  if (!detailQ.data) return null;

  // Tier 5.C — tasks + events are now rendered exclusively in UnifiedTimeline
  // (Tier 0.F merged them into the unified activities feed). The detail
  // response still ships them for back-compat, but consumers should read
  // from `activities`. Drop the unused destructured fields.
  // Tier 6.B — humanOwnerProfile no longer rendered (CurrentOwnerLine removed;
  // ownership is shown by the OwnershipBadge chip + HandlerBanner above the
  // timeline). The detail response still ships it for future per-owner
  // surfaces.
  const { lead, messages, queueItems } = detailQ.data;
  // Tier 0.F.1 — UnifiedTimeline reads from the new activities feed
  // when the migration-054 server is live; falls back to nothing so
  // the empty state renders gracefully if the field is missing during
  // a partial rollout. Once the rollout settles, the `?? []` becomes
  // the only path and the legacy messages/events/tasks/queueItems
  // arrays can drop from this destructuring (Tier 1).
  const activities = detailQ.data.activities ?? [];
  const deals = detailQ.data.deals ?? [];
  const meetings = detailQ.data.meetings ?? [];
  const programMember = detailQ.data.programMember ?? null;

  return (
    <div className="space-y-4">
      <Link to="/leads" className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline">
        ← חזרה לרשימה
      </Link>

      {/* Tier 6.B — header pass two. The previous header had THREE
          places saying "AI is handling this lead" (CurrentOwnerLine
          banner, OwnershipBadge chip, HandlerBanner above timeline),
          a heavy ProductFocusStrip that duplicated the classification
          card AND the OperatorGuidanceCard recommendation, a contact
          grid with 6 fields most managers never read, and an AI
          playbook debug subtitle. Now: one identity line, one chip
          row, contact essentials only (phone/email/source). The rest
          collapses behind "פרטים נוספים". HandlerBanner above the
          timeline stays as the contextual ownership signal. */}
      <header className="kf-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {lead.full_name || 'ליד ללא שם'}
          </h1>
          {lead.do_not_contact ? <span className="kf-badge bg-rose-100 text-rose-700">לא ליצור קשר</span> : null}
          {lead.removed_by_request ? (
            <span className="kf-badge bg-rose-100 text-rose-700">הוסר לבקשתו</span>
          ) : null}
        </div>

        <dl className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-slate-600">
          <ContactRow label="טלפון" value={lead.phone} kind="phone" />
          <ContactRow label="אימייל" value={lead.email} kind="email" />
          <DataRow label="מקור" value={lead.source ? labelOr(SOURCE_LABELS, lead.source) : null} />
        </dl>

        {/* Status row — same chips as before, no longer competes with
            a duplicate CurrentOwnerLine banner. */}
        <div className="mt-3 flex flex-wrap items-center gap-2 sm:gap-3">
          <StatusBadge status={lead.lead_status} />
          <OwnershipBadge ownership={lead.ownership_mode} />
          <HeatBadge heat={lead.lead_heat} />
          <span className="kf-badge kf-badge-mute">ציון {lead.lead_score}</span>
          <NextActionBadge actionType={lead.next_action_type} dueAt={lead.next_action_due_at} />
        </div>

        {/* Long-tail metadata collapses behind a disclosure. AI playbook
            stage is mostly debug info; created / last-in / last-out are
            interesting once a week, not every conversation. */}
        <details className="mt-3 text-xs text-slate-500">
          <summary className="cursor-pointer hover:text-slate-700">פרטים נוספים</summary>
          <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
            <DataRow label="נוצר" value={formatDateTime(lead.created_at)} />
            <DataRow label="נכנס לאחרונה" value={formatRelative(lead.last_inbound_at)} />
            <DataRow label="יצא לאחרונה" value={formatRelative(lead.last_outbound_at)} />
            {lead.ai_playbook_stage ? (
              <DataRow
                label="שלב AI"
                value={`${AI_PLAYBOOK_STAGE_LABELS[lead.ai_playbook_stage] ?? lead.ai_playbook_stage}${lead.ai_playbook_stage_at ? ` · ${formatRelative(lead.ai_playbook_stage_at)}` : ''}`}
              />
            ) : null}
          </dl>
        </details>

        {/* Tier 5.D — lifecycle action bar.
            Before: 6 buttons in 3 ActionGroups fought the OperatorGuidanceCard
            below for "what should I click next?". A beginner couldn't tell
            which one was right.
            After: a single "פעולות נוספות" disclosure that hides all 6 by
            default. The OperatorGuidanceCard now owns the primary CTA;
            the disclosure is only opened when the operator needs to
            override the recommendation. Reopen is always visible (it's
            already gated to terminal states + admin role).
            Server-side gate stays: only owner / admin / mia see these.
        */}
        {auth.role === 'owner' || auth.role === 'admin' || auth.role === 'mia' ? (
          <div className="mt-4">
            {/* Reopen is a rare override on dead leads — keep it visible
                so an admin doesn't have to dig into "more". */}
            {(lead.lead_status === 'won' || lead.lead_status === 'lost' || lead.do_not_contact) &&
            (auth.role === 'owner' || auth.role === 'admin') ? (
              <div className="mb-2">
                <button type="button" className="kf-btn kf-btn-primary" onClick={() => setReopenOpen(true)}>
                  פתח שיחה מחדש
                </button>
              </div>
            ) : null}
            <details className="group">
              <summary className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                פעולות נוספות
                <svg viewBox="0 0 16 16" className="h-4 w-4 transition group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="1.7"><path strokeLinecap="round" d="M4 6l4 4 4-4" /></svg>
              </summary>
              <div className="mt-2 flex flex-wrap gap-2">
                <ActionGroup label="בעלות">
                  <button
                    type="button"
                    className="kf-btn"
                    onClick={() => action.mutate({ action: 'assign_to_mia', label: 'הועבר לנציג' })}
                  >
                    העברה לנציג
                  </button>
                  <button
                    type="button"
                    className="kf-btn"
                    onClick={() => action.mutate({ action: 'return_to_ai', label: 'הוחזר ל-AI' })}
                  >
                    החזרה ל-AI
                  </button>
                  <button
                    type="button"
                    className="kf-btn"
                    onClick={() => action.mutate({ action: 'mark_phone_escalation', label: 'סומן לשיחה' })}
                  >
                    סימון לשיחה
                  </button>
                </ActionGroup>
                <ActionGroup label="סטטוס">
                  <button
                    type="button"
                    className="kf-btn kf-btn-primary"
                    onClick={() =>
                      setPendingAction({
                        action: 'mark_won',
                        label: 'נסגר ברכישה',
                        description: 'לסמן את הליד כסגירה ולהפעיל את תהליך האונבורדינג (מסע + עמלה)?\n\nדורש עסקה פתוחה — אם אין, צור אחת ב-״מסלולים ועסקאות״ קודם.',
                        destructive: false,
                      })
                    }
                  >
                    סימון כסגירה
                  </button>
                  <button
                    type="button"
                    className="kf-btn"
                    onClick={() =>
                      setPendingAction({
                        action: 'mark_lost',
                        note: 'manual_close',
                        label: 'סומן כאבוד',
                        description: 'לסמן את הליד כאבוד. פעולה זו לא ניתנת לשחזור.',
                        destructive: true,
                      })
                    }
                  >
                    סימון כאבוד
                  </button>
                </ActionGroup>
                <ActionGroup label="הסרה">
                  <button
                    type="button"
                    className="kf-btn kf-btn-danger"
                    onClick={() =>
                      setPendingAction({
                        action: 'mark_dnc',
                        label: 'סומן כ-DNC',
                        description:
                          'לסמן את הליד כ-Do Not Contact (אסור-ליצור-קשר). הבוט יפסיק לפנות אליו ולא יישלחו עוד הודעות.',
                        destructive: true,
                      })
                    }
                  >
                    סימון כ-DNC
                  </button>
                </ActionGroup>
                {auth.role === 'owner' || auth.role === 'admin' ? (
                  <ActionGroup label="מחיקה">
                    <button
                      type="button"
                      className="kf-btn kf-btn-danger"
                      onClick={() => setDeleteOpen(true)}
                    >
                      מחיקת ליד
                    </button>
                  </ActionGroup>
                ) : null}
              </div>
            </details>
          </div>
        ) : null}
        {action.error ? (
          <p className="mt-2 text-sm text-rose-600">{(action.error as Error).message}</p>
        ) : null}
      </header>

      <OperatorGuidanceCard
        lead={lead}
        queueItems={queueItems}
        messages={messages}
        canAct={auth.role === 'owner' || auth.role === 'admin' || auth.role === 'mia'}
        busy={action.isPending}
        onAssignToMia={() => action.mutate({ action: 'assign_to_mia', label: 'הועבר לנציג' })}
        onReturnToAi={() => action.mutate({ action: 'return_to_ai', label: 'הוחזר ל-AI' })}
        onMarkPhone={() => action.mutate({ action: 'mark_phone_escalation', label: 'סומן לשיחה' })}
      />

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="kf-card p-4 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">
              שיחה
              {detailQ.data?.conversations[0]?.channel === 'instagram' ? (
                <span className="ms-2 inline-flex items-center rounded-full bg-fuchsia-100 px-2 py-0.5 text-xs font-medium text-fuchsia-700">אינסטגרם</span>
              ) : null}
            </h2>
            {lead.phone ? (
              <a
                href={waLink(lead.phone)}
                target="_blank"
                rel="noopener noreferrer"
                className="kf-btn kf-btn-ghost text-xs"
                title="פתיחת שיחה ב-WhatsApp"
              >
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                  <path d="M10 2.5a7.5 7.5 0 0 0-6.4 11.4L2.5 17.5l3.7-1.1A7.5 7.5 0 1 0 10 2.5Zm4.4 10.6c-.2.6-1 1.1-1.6 1.2-.4.1-.9.1-3-.7-2.5-1-4.1-3.5-4.2-3.7-.1-.2-1-1.3-1-2.5 0-1.2.6-1.7.9-2 .2-.2.4-.2.6-.2h.4c.1 0 .3 0 .5.4.2.5.7 1.6.7 1.7s.1.2 0 .3c-.1.2-.1.3-.3.4-.1.1-.2.3-.4.4-.1.1-.3.3-.1.5.2.4.7 1.1 1.5 1.8 1 .9 1.8 1.2 2.1 1.3.3.1.5.1.6 0 .2-.2.7-.8.9-1 .2-.3.4-.2.6-.1.3.1 1.7.8 2 .9.3.1.4.2.5.4.1.2.1.7-.1 1.3Z" />
                </svg>
                WhatsApp
              </a>
            ) : null}
          </div>
          <HandlerBanner ownership={lead.ownership_mode} lastHumanTouchAt={lead.last_human_touch_at} />
          {/* Tier 0.F.1 — Universal Record Screen feed. UnifiedTimeline
              replaces the legacy Transcript with one chronological pane
              that absorbs messages + events + tasks + queue items into
              the same scroll surface, matching the v4 spec § ג'. */}
          <UnifiedTimeline activities={activities} />
          <ReplyBox
            disabled={!conversationId || lead.do_not_contact || lead.removed_by_request}
            onSend={(text) => sendReply.mutate(text)}
            sending={sendReply.isPending}
            errorMessage={sendReply.error ? (sendReply.error as Error).message : null}
            lead={lead}
            channel={detailQ.data?.conversations[0]?.channel ?? 'whatsapp'}
          />
        </div>

        <aside className="space-y-4">
          {/* Operator-editable identity card. Phone is intentionally read-only
              (it's the routing key for inbound webhooks; rewriting it would
              orphan the conversation history). */}
          <div className="kf-card p-4">
            <h2 className="font-semibold">פרטי קשר</h2>
            <dl className="mt-2 space-y-1 text-sm">
              <EditableRow
                k="שם מלא"
                v={lead.full_name}
                editable={canEditMeta}
                onSave={(next) => updateMeta.mutate({ full_name: next })}
              />
              <EditableRow
                k="אימייל"
                v={lead.email}
                editable={canEditMeta}
                onSave={(next) => updateMeta.mutate({ email: next })}
              />
              <EditableRow
                k="עיר"
                v={lead.city}
                editable={canEditMeta}
                onSave={(next) => updateMeta.mutate({ city: next })}
              />
              <Row k="טלפון" v={lead.phone} />
            </dl>
          </div>

          {/* Tier 5.D — single "סיווג ואבחון" card replaces the three
              earlier siblings (heat/fit/readiness + intake/product +
              goal/pain). Hot-path fields stay at the top always-visible;
              the long tail collapses into <details> so a beginner sees
              only what changes every conversation. */}
          <div className="kf-card p-4">
            <h2 className="font-semibold">סיווג ואבחון</h2>
            <p className="mt-1 text-xs text-slate-500">
              הסיווג העיקרי תמיד גלוי. השאר נפתח כשצריך.
            </p>

            {/* Always-visible: the 4 fields Mia changes most often. */}
            <dl className="mt-3 space-y-1 text-sm">
              <EditableEnumRow
                k="מסלול ראשי"
                v={lead.primary_track}
                editable={canEditMeta}
                options={[
                  { value: 'program', label: 'תכנית הליווי' },
                  { value: 'presale', label: 'פריסייל / חתימה' },
                  { value: 'investor_mentorship', label: 'ליווי משקיעים' },
                ]}
                onSave={(next) => updateMeta.mutate({ primary_track: next as 'program' | 'presale' | 'investor_mentorship' | null })}
              />
              <EditableEnumRow
                k="חום"
                v={lead.lead_heat}
                editable={canEditMeta}
                options={[
                  { value: 'hot', label: 'חם' },
                  { value: 'warm', label: 'פושר' },
                  { value: 'cool', label: 'צונן' },
                  { value: 'cold', label: 'קר' },
                ]}
                onSave={(next) => updateMeta.mutate({ lead_heat: next as LeadHeat | null })}
              />
              <EditableEnumRow
                k="התאמה"
                v={lead.lead_fit}
                editable={canEditMeta}
                options={[
                  { value: 'high', label: 'גבוהה' },
                  { value: 'medium', label: 'בינונית' },
                  { value: 'low', label: 'נמוכה' },
                ]}
                onSave={(next) => updateMeta.mutate({ lead_fit: next as LeadFit | null })}
              />
              <EditableEnumRow
                k="בשלות"
                v={lead.readiness_level}
                editable={canEditMeta}
                options={[
                  { value: 'paying', label: 'משלם' },
                  { value: 'decided', label: 'החליט' },
                  { value: 'considering', label: 'שוקל' },
                  { value: 'exploring', label: 'מתעניין' },
                ]}
                onSave={(next) => updateMeta.mutate({ readiness_level: next as ReadinessLevel | null })}
              />
            </dl>

            <details className="mt-3 rounded-md border border-slate-200 p-3">
              <summary className="cursor-pointer text-sm font-medium text-slate-700">קליטה ואבחון AI</summary>
              <dl className="mt-2 space-y-1 text-sm">
                <EditableEnumRow
                  k="סוג פנייה"
                  v={lead.inquiry_type}
                  editable={canEditMeta}
                  options={INQUIRY_OPTIONS}
                  onSave={(next) => updateMeta.mutate({ inquiry_type: next as InquiryType | null })}
                />
                <EditableEnumRow
                  k="מוצר"
                  v={lead.product_interest}
                  editable={canEditMeta}
                  options={PRODUCT_OPTIONS}
                  onSave={(next) => updateMeta.mutate({ product_interest: next as ProductInterest | null })}
                />
                <EditableEnumRow
                  k="מסלול טיפול"
                  v={lead.intake_segment}
                  editable={canEditMeta}
                  options={SEGMENT_OPTIONS}
                  onSave={(next) => updateMeta.mutate({ intake_segment: next as IntakeSegment | null })}
                />
                <Row
                  k="ביטחון סיווג"
                  v={
                    lead.classification_confidence
                      ? CLASSIFICATION_CONFIDENCE_LABELS[lead.classification_confidence]
                      : null
                  }
                />
                <Row k="סיכום" v={lead.classification_summary} />
                <Row k="פעולה מומלצת" v={lead.suggested_next_action} />
                <Row k="סיבת העברה" v={lead.handoff_reason} />
                <Row
                  k="עודכן"
                  v={lead.classification_updated_at ? formatRelative(lead.classification_updated_at) : null}
                />
              </dl>
            </details>

            <details className="mt-2 rounded-md border border-slate-200 p-3">
              <summary className="cursor-pointer text-sm font-medium text-slate-700">הקשר ויעדים</summary>
              <dl className="mt-2 space-y-1 text-sm">
                <EditableRow
                  k="מטרה"
                  v={lead.goal_summary}
                  editable={canEditMeta}
                  saving={updateMeta.isPending && 'goal_summary' in (updateMeta.variables ?? {})}
                  onSave={(next) => updateMeta.mutate({ goal_summary: next })}
                />
                <EditableRow
                  k="כאב מרכזי"
                  v={lead.pain_point_summary}
                  editable={canEditMeta}
                  saving={updateMeta.isPending && 'pain_point_summary' in (updateMeta.variables ?? {})}
                  onSave={(next) => updateMeta.mutate({ pain_point_summary: next })}
                />
                <EditableRow
                  k="חסם עיקרי"
                  v={lead.main_blocker}
                  editable={canEditMeta}
                  saving={updateMeta.isPending && 'main_blocker' in (updateMeta.variables ?? {})}
                  onSave={(next) => updateMeta.mutate({ main_blocker: next })}
                />
                <EditableRow
                  k="הקשר החלטה"
                  v={lead.decision_context}
                  editable={canEditMeta}
                  onSave={(next) => updateMeta.mutate({ decision_context: next })}
                />
                <EditableRow
                  k="פעולה הבאה"
                  v={lead.next_action_type}
                  editable={canEditMeta}
                  saving={updateMeta.isPending && 'next_action_type' in (updateMeta.variables ?? {})}
                  onSave={(next) => updateMeta.mutate({ next_action_type: next })}
                />
                <Row k="עד" v={lead.next_action_due_at ? formatDateTime(lead.next_action_due_at) : null} />
                <Row k="סטטוס תשלום" v={lead.payment_status} />
                {lead.lead_status === 'lost' || lead.lost_reason ? (
                  <EditableRow
                    k="סיבת אובדן"
                    v={lead.lost_reason}
                    editable={canEditMeta}
                    onSave={(next) => updateMeta.mutate({ lost_reason: next })}
                  />
                ) : null}
              </dl>
            </details>
          </div>

          <PipelineOverviewCard
            lead={lead}
            deals={deals}
            meetings={meetings}
            programMember={programMember}
            canAdvance={auth.role === 'owner' || auth.role === 'admin' || auth.role === 'mia' || auth.role === 'sales_rep'}
            advancing={action.isPending}
            canSchedule={auth.role === 'owner' || auth.role === 'admin' || auth.role === 'mia' || auth.role === 'sales_rep'}
            scheduling={scheduleMeeting.isPending}
            updatingMeeting={updateMeetingStatus.isPending}
            onSchedule={(input) => scheduleMeeting.mutate(input)}
            onUpdateMeetingStatus={(input) => updateMeetingStatus.mutate(input)}
            onAdvance={(deal, targetStage) =>
              action.mutate({
                action: 'advance_deal_stage',
                label: 'שלב העסקה עודכן',
                note: `advance:${deal.stage}->${targetStage}`,
                dealId: deal.id,
                targetStage,
              })
            }
          />


          {/* Tier 5.C — sidebar slimming. The earlier "תורי עבודה" /
              "משימות" / "היסטוריית אירועים" cards listed the same rows
              the UnifiedTimeline already renders chronologically. The
              only unique value was the queue-close button — kept here
              as a compact action list of *pending* items only, so Mia
              can resolve a queue item without scrolling the timeline.
              Done items are read in the timeline. */}
          {queueItems.filter((q) => q.status === 'pending' || q.status === 'claimed').length > 0 ? (
            <div className="kf-card p-4">
              <h2 className="font-semibold">פעולות פתוחות</h2>
              <p className="text-xs text-slate-500">פריטים שמחכים לסגירה ידנית. ההיסטוריה המלאה בציר הזמן.</p>
              <ul className="mt-2 space-y-2">
                {queueItems
                  .filter((q) => q.status === 'pending' || q.status === 'claimed')
                  .map((q) => (
                    <li key={q.id} className="rounded-md bg-slate-50 p-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <strong>{QUEUE_LABELS[q.queue_type] ?? q.queue_type}</strong>
                        <span className="text-xs text-slate-500">{q.status}</span>
                      </div>
                      {q.reason ? <div className="text-slate-600">{q.reason}</div> : null}
                      <button
                        type="button"
                        className="kf-btn mt-2 text-xs"
                        onClick={() => {
                          setPendingQueueClose({
                            id: q.id,
                            label: QUEUE_LABELS[q.queue_type] ?? q.queue_type,
                          });
                          setQueueCloseNote('');
                        }}
                      >
                        סגירה
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}

          {/* Tier 7.D.3 — call log is a low-frequency action. Collapsed
              by default so the sidebar stays compact for the 80% of leads
              that aren't getting a phone log in this session. */}
          {auth.role === 'sales_rep' ||
          auth.role === 'mia' ||
          auth.role === 'admin' ||
          auth.role === 'owner' ? (
            <details className="kf-card p-4">
              <summary className="cursor-pointer text-base font-semibold text-slate-800">
                תיעוד שיחת טלפון
              </summary>
              <div className="mt-2">
                <CallLogForm
                  onSubmit={(outcome, durationMinutes, note) =>
                    logCall.mutate({ outcome, durationMinutes, note })
                  }
                  submitting={logCall.isPending}
                  errorMessage={logCall.error ? (logCall.error as Error).message : null}
                />
              </div>
            </details>
          ) : null}

          {/* Tier 4.C — per-contact automation + journey history. Mia
              uses this when investigating "did the engine do anything
              with this lead?". Lazy-loaded queries so the lead detail
              first paint stays fast. */}
          <AutomationHistoryCard contactId={lead.id} />
        </aside>
      </section>

      <ConfirmDialog
        open={!!pendingAction}
        title={pendingAction?.label ?? t('destructive_action_title')}
        description={pendingAction?.description ?? t('destructive_action_warning')}
        destructive={pendingAction?.destructive ?? false}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => {
          if (!pendingAction) return;
          action.mutate({
            action: pendingAction.action,
            note: pendingAction.note,
            label: pendingAction.label,
          });
          setPendingAction(null);
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="מחיקת ליד"
        description={`למחוק את הליד${detailQ.data?.lead.full_name ? ` "${detailQ.data.lead.full_name}"` : ''}? הוא יוסר מהרשימות הפעילות וההיסטוריה תישמר. ניתן לשחזר דרך מנהל.`}
        confirmLabel="מחיקה"
        destructive
        busy={deleteLead.isPending}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => deleteLead.mutate()}
      />

      <ConfirmDialog
        open={!!pendingQueueClose}
        title={`סגירת פריט תור — ${pendingQueueClose?.label ?? ''}`}
        description="ניתן להוסיף סיבת סגירה לצרכי תיעוד (אופציונלי)."
        confirmLabel="סגירה"
        busy={resolveQueue.isPending}
        onCancel={() => setPendingQueueClose(null)}
        onConfirm={() => {
          if (!pendingQueueClose) return;
          const note = queueCloseNote.trim();
          resolveQueue.mutate({ queueItemId: pendingQueueClose.id, note: note.length ? note : undefined });
          setPendingQueueClose(null);
        }}
      >
        <label className="block text-sm">
          <span className="text-slate-600">סיבת סגירה</span>
          <textarea
            className="kf-input mt-1 min-h-[64px]"
            placeholder="לדוגמה: ליד חזר ונענה, פוטר אוטומטית..."
            value={queueCloseNote}
            onChange={(e) => setQueueCloseNote(e.target.value.slice(0, 500))}
            maxLength={500}
          />
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        open={reopenOpen}
        title="פתיחת ליד מחדש"
        description="הליד יחזור לסטטוס פעיל. אם הוא נסגר כ-Won/Lost שדות הסגירה יתאפסו; תשלומים שכבר נרשמו יישארו לתיעוד."
        confirmLabel="פתיחה מחדש"
        busy={reopen.isPending}
        onCancel={() => setReopenOpen(false)}
        onConfirm={() => {
          const note = reopenNote.trim();
          reopen.mutate({ targetStatus: reopenTarget, note: note.length ? note : null });
        }}
      >
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="text-slate-600">סטטוס יעד</span>
            <select
              className="kf-input mt-1"
              value={reopenTarget}
              onChange={(e) => setReopenTarget(e.target.value as ReopenTarget)}
            >
              <option value="responded">הגיב</option>
              <option value="qualified">מוסמך</option>
              <option value="nurture">בליווי</option>
              <option value="human_handoff">העברה לאנושי</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">סיבה (אופציונלי)</span>
            <textarea
              className="kf-input mt-1 min-h-[64px]"
              placeholder="לדוגמה: סווג בטעות, הלקוח חזר, אי-הבנה..."
              value={reopenNote}
              onChange={(e) => setReopenNote(e.target.value.slice(0, 500))}
              maxLength={500}
            />
          </label>
        </div>
      </ConfirmDialog>
    </div>
  );
}

function OperatorGuidanceCard({
  lead,
  queueItems,
  messages,
  canAct,
  busy,
  onAssignToMia,
  onReturnToAi,
  onMarkPhone,
}: {
  lead: LeadDetailType;
  queueItems: QueueRow[];
  messages: MessageRow[];
  canAct: boolean;
  busy: boolean;
  onAssignToMia: () => void;
  onReturnToAi: () => void;
  onMarkPhone: () => void;
}) {
  const insight = operatorInsight(lead, queueItems, messages);
  const resolutionGuide = leadResolutionGuide(lead, insight.primaryAction);
  const primaryLabel =
    insight.primaryAction === 'return_ai'
      ? 'להחזיר למענה אוטומטי'
      : insight.primaryAction === 'phone'
        ? 'לסמן לשיחת טלפון'
        : insight.primaryAction === 'takeover'
          ? 'לקחת לטיפול אנושי'
          : null;
  const primaryHandler =
    insight.primaryAction === 'return_ai'
      ? onReturnToAi
      : insight.primaryAction === 'phone'
        ? onMarkPhone
        : insight.primaryAction === 'takeover'
          ? onAssignToMia
          : undefined;

  return (
    <section
      className={clsx('rounded-2xl border p-4 shadow-sm sm:p-5', insight.tone)}
      aria-label="המלצת פעולה למפעילה"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-white/75 px-2.5 py-1 text-xs font-semibold ring-1 ring-black/5">
            הפעולה הבאה
          </span>
          <span className="text-xs font-medium opacity-75">{insight.ownerLine}</span>
        </div>
        {/* Primary action moved inline next to the title — the right-side
            column with 3 buttons (Tier 6 audit) duplicated WhatsApp
            (header) and "להעביר לאדם" (action bar overflow). Only the
            single recommended action earns the primary slot here. */}
        {canAct && primaryLabel && primaryHandler ? (
          <button
            type="button"
            className="kf-btn kf-btn-primary"
            disabled={busy}
            onClick={primaryHandler}
          >
            {primaryLabel}
          </button>
        ) : null}
      </div>
      <h2 className="mt-2 text-xl font-semibold tracking-tight">{insight.title}</h2>
      <p className="mt-1 max-w-3xl text-sm leading-6 opacity-85">{insight.detail}</p>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <GuidanceMiniCard label="למה זה כאן" value={insight.why} />
        <GuidanceMiniCard label="מה להגיד עכשיו" value={insight.script} />
      </div>

      {/* Tier 7.C.2 — fully dismissible. Mia/admin who's been around
          for a week shouldn't see this every lead. Once dismissed, a
          tiny "הצג מדריך" link replaces the disclosure so she can
          reopen for a tricky one. */}
      <ResolutionGuide items={resolutionGuide} />

      {!canAct ? (
        <p className="mt-3 text-sm opacity-75">יש לך הרשאת צפייה בלבד, לכן הפעולות מוסתרות.</p>
      ) : null}
      {/* intake_segment chip dropped from the top row — it's already
          visible inside the סיווג ואבחון sidebar card. */}
      <span className="sr-only">
        {lead.intake_segment ? SEGMENT_OPTIONS.find((option) => option.value === lead.intake_segment)?.label : ''}
      </span>
    </section>
  );
}

// Tier 7.C.2 — dismissible resolution guide. Pattern mirrors
// InboxTrainingGuide (Tier 5.C): localStorage flag persists per
// browser, "הצג מדריך" link reopens it for an unfamiliar lead.
const RESOLUTION_GUIDE_DISMISSED_KEY = 'karnaf_operator_resolution_dismissed_v1';
function ResolutionGuide({
  items,
}: {
  items: Array<{ title: string; when: string; action: string }>;
}) {
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(RESOLUTION_GUIDE_DISMISSED_KEY) === '1';
  });
  function dismiss() {
    try { window.localStorage.setItem(RESOLUTION_GUIDE_DISMISSED_KEY, '1'); }
    catch { /* ignore — private mode etc. */ }
    setDismissed(true);
  }
  function reopen() {
    try { window.localStorage.removeItem(RESOLUTION_GUIDE_DISMISSED_KEY); }
    catch { /* ignore */ }
    setDismissed(false);
  }
  if (dismissed) {
    return (
      <button type="button" onClick={reopen} className="mt-2 text-xs text-slate-500 hover:underline">
        הצג מדריך סיום טיפול
      </button>
    );
  }
  return (
    <details className="group mt-3 rounded-xl bg-white/55 ring-1 ring-black/5">
      <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-sm font-medium opacity-80 hover:opacity-100">
        <span>איך לסגור נכון את הטיפול?</span>
        <button type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); dismiss(); }}
          className="text-xs text-slate-500 hover:underline"
          title="הסתר לצמיתות; אפשר להציג שוב דרך הקישור שיופיע"
        >
          הסתר
        </button>
      </summary>
      <div className="grid gap-2 px-3 pb-3 md:grid-cols-2">
        {items.map((item) => (
          <div key={item.title} className="rounded-xl bg-white/75 p-3 ring-1 ring-black/5">
            <p className="text-sm font-semibold">{item.title}</p>
            <p className="mt-1 text-xs leading-5 opacity-75">{item.when}</p>
            <p className="mt-2 text-xs font-medium opacity-90">{item.action}</p>
          </div>
        ))}
      </div>
    </details>
  );
}

function GuidanceMiniCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/65 p-3 ring-1 ring-black/5">
      <p className="text-xs font-semibold opacity-60">{label}</p>
      <p className="mt-1 text-sm leading-6 opacity-90">{value}</p>
    </div>
  );
}

function PipelineOverviewCard({
  lead,
  deals,
  meetings,
  programMember,
  canAdvance,
  advancing,
  canSchedule,
  scheduling,
  updatingMeeting,
  onSchedule,
  onUpdateMeetingStatus,
  onAdvance,
}: {
  lead: LeadDetailType;
  deals: DealRow[];
  meetings: MeetingRow[];
  programMember: ProgramMemberRow | null;
  canAdvance: boolean;
  advancing: boolean;
  canSchedule: boolean;
  scheduling: boolean;
  updatingMeeting: boolean;
  onSchedule: (input: {
    meetingType: MeetingRow['meeting_type'];
    startsAt: string;
    endsAt: string | null;
    summary: string | null;
    meetingUrl: string | null;
    dealId: string | null;
  }) => void;
  onUpdateMeetingStatus: (input: { meetingId: string; status: MeetingRow['status']; note: string | null }) => void;
  onAdvance: (deal: DealRow, targetStage: string) => void;
}) {
  const nextMeeting = [...meetings]
    .filter((m) => m.status === 'scheduled')
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())[0];

  return (
    <div className="kf-card p-4">
      <h2 className="font-semibold">מסלולים ועסקאות</h2>
      <p className="mt-1 text-xs text-slate-500">
        שכבת ה־PRD החדשה: איש קשר אחד יכול להחזיק כמה מסלולי מכירה במקביל.
      </p>
      <dl className="mt-3 space-y-1 text-sm">
        <Row k="מסלול ראשי" v={lead.primary_track ? PRD_TRACK_LABELS[lead.primary_track] ?? lead.primary_track : null} />
        <Row k="נושא עניין" v={lead.interest_topic} />
        <Row k="תגיות" v={lead.tags?.length ? lead.tags.join(', ') : null} />
        <Row k="הסכמת WhatsApp" v={formatConsent(lead.consent_whatsapp)} />
        <Row k="הסכמת מייל" v={formatConsent(lead.consent_email)} />
        <Row
          k="חבר תכנית"
          v={programMember ? `${PROGRAM_PROGRESS_LABELS[programMember.progress_stage] ?? programMember.progress_stage} · ${formatDateTime(programMember.joined_at)}` : null}
        />
        <Row
          k="פגישה קרובה"
          v={nextMeeting ? `${MEETING_TYPE_LABELS[nextMeeting.meeting_type]} · ${formatDateTime(nextMeeting.starts_at)}` : null}
        />
      </dl>

      {canSchedule ? (
        <ScheduleMeetingForm deals={deals.filter((deal) => deal.status === 'open')} submitting={scheduling} onSubmit={onSchedule} />
      ) : null}

      {meetings.length ? (
        <MeetingsList meetings={meetings} canUpdate={canSchedule} updating={updatingMeeting} onUpdate={onUpdateMeetingStatus} />
      ) : null}

      {deals.length ? (
        <ul className="mt-3 space-y-2">
          {deals.map((deal) => {
            // Tier 1.E — track-adaptive deal card. Each track surfaces
            // the entity that matters for it: investor_mentorship shows
            // the partner + their commission stripe, presale shows the
            // project + funding context, program shows just the stage.
            // Falls back to the legacy partner_name / presale_project
            // text shadows when the FKs aren't populated yet.
            const partnerLabel = deal.partner?.full_name ?? deal.partner_name;
            const projectLabel = deal.project?.name ?? deal.presale_project;
            const commission = deal.commission;
            return (
              <li key={deal.id} className="rounded-md bg-slate-50 p-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <strong>{PRD_TRACK_LABELS[deal.track] ?? deal.track}</strong>
                  <span className="text-xs text-slate-500">{DEAL_STATUS_LABELS[deal.status] ?? deal.status}</span>
                </div>
                <div className="mt-1 text-slate-600">
                  שלב: {DEAL_STAGE_LABELS[deal.stage] ?? deal.stage}
                  {deal.value ? ` · ${deal.value.toLocaleString('he-IL')} ${deal.currency}` : ''}
                </div>
                {deal.track === 'investor_mentorship' && partnerLabel ? (
                  <div className="mt-1 text-xs text-slate-500">
                    שותף: {partnerLabel}
                    {deal.partner?.domain ? ` · ${PARTNER_DOMAIN_LABELS[deal.partner.domain] ?? deal.partner.domain}` : ''}
                  </div>
                ) : null}
                {deal.track === 'presale' && projectLabel ? (
                  <div className="mt-1 text-xs text-slate-500">
                    פרויקט: {projectLabel}
                    {deal.project?.city ? ` · ${deal.project.city}` : ''}
                  </div>
                ) : null}
                {commission ? (
                  <div className={clsx(
                    'mt-2 flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs',
                    commission.status === 'pending' && 'bg-amber-50 text-amber-800',
                    commission.status === 'to_bill' && 'bg-rose-50 text-rose-800',
                    commission.status === 'paid' && 'bg-emerald-50 text-emerald-800',
                    commission.status === 'cancelled' && 'bg-slate-100 text-slate-600',
                  )}>
                    <span>
                      עמלה: {COMMISSION_STATUS_LABELS[commission.status] ?? commission.status}
                    </span>
                    <span className="tabular-nums font-medium">
                      {(commission.amount_received ?? commission.amount_due).toLocaleString('he-IL')} {commission.currency}
                    </span>
                  </div>
                ) : null}
                {canAdvance && deal.status === 'open' ? (
                  <DealStageActions deal={deal} busy={advancing} onAdvance={onAdvance} />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-slate-500">עדיין אין Deal פתוח/היסטורי לליד הזה.</p>
      )}
    </div>
  );
}

function ScheduleMeetingForm({
  deals,
  submitting,
  onSubmit,
}: {
  deals: DealRow[];
  submitting: boolean;
  onSubmit: (input: {
    meetingType: MeetingRow['meeting_type'];
    startsAt: string;
    endsAt: string | null;
    summary: string | null;
    meetingUrl: string | null;
    dealId: string | null;
  }) => void;
}) {
  const [meetingType, setMeetingType] = useState<MeetingRow['meeting_type']>('phone');
  const [startsAt, setStartsAt] = useState('');
  const [duration, setDuration] = useState('30');
  const [dealId, setDealId] = useState('');
  const [meetingUrl, setMeetingUrl] = useState('');
  const [summary, setSummary] = useState('');

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!startsAt) return;
    const start = new Date(startsAt);
    const minutes = Math.max(5, Math.min(240, Number(duration) || 30));
    const end = Number.isFinite(start.getTime()) ? new Date(start.getTime() + minutes * 60_000).toISOString() : null;
    onSubmit({
      meetingType,
      startsAt: start.toISOString(),
      endsAt: end,
      summary: summary.trim() || null,
      meetingUrl: meetingUrl.trim() || null,
      dealId: dealId || null,
    });
    setSummary('');
    setMeetingUrl('');
  }

  return (
    <form onSubmit={submit} className="mt-3 rounded-2xl border border-slate-100 bg-slate-50 p-3 text-sm">
      <div className="mb-2 font-semibold text-slate-800">תיאום פגישה</div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="text-slate-600">סוג</span>
          <select className="kf-input mt-1" value={meetingType} onChange={(e) => setMeetingType(e.target.value as MeetingRow['meeting_type'])}>
            <option value="phone">טלפון</option>
            <option value="zoom">זום</option>
            <option value="office">משרד</option>
          </select>
        </label>
        <label className="block">
          <span className="text-slate-600">מועד</span>
          <input className="kf-input mt-1" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
        </label>
        <label className="block">
          <span className="text-slate-600">משך בדקות</span>
          <input className="kf-input mt-1" type="number" min={5} max={240} value={duration} onChange={(e) => setDuration(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-slate-600">Deal לקישור</span>
          <select className="kf-input mt-1" value={dealId} onChange={(e) => setDealId(e.target.value)}>
            <option value="">ללא קישור</option>
            {deals.map((deal) => (
              <option key={deal.id} value={deal.id}>{PRD_TRACK_LABELS[deal.track] ?? deal.track} · {DEAL_STAGE_LABELS[deal.stage] ?? deal.stage}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="mt-2 block">
        <span className="text-slate-600">קישור פגישה</span>
        <input className="kf-input mt-1" value={meetingUrl} onChange={(e) => setMeetingUrl(e.target.value)} placeholder="Zoom / Calendly / כתובת" />
      </label>
      <textarea className="kf-input mt-2 min-h-[64px]" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="סיכום קצר או מטרת הפגישה..." />
      <p className="mt-2 text-xs leading-5 text-slate-500">הפעולה מתעדת פגישה ב-CRM בלבד. אין יצירת אירוע Calendar או שליחת הודעה ללקוח.</p>
      <button type="submit" className="kf-btn kf-btn-primary mt-2" disabled={submitting || !startsAt}>{submitting ? 'שומר...' : 'שמירת פגישה'}</button>
    </form>
  );
}

function MeetingsList({
  meetings,
  canUpdate,
  updating,
  onUpdate,
}: {
  meetings: MeetingRow[];
  canUpdate: boolean;
  updating: boolean;
  onUpdate: (input: { meetingId: string; status: MeetingRow['status']; note: string | null }) => void;
}) {
  return (
    <div className="mt-3 rounded-2xl border border-slate-100 bg-white p-3">
      <div className="text-sm font-semibold text-slate-800">פגישות</div>
      <ul className="mt-2 space-y-2 text-sm">
        {[...meetings]
          .sort((a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime())
          .map((meeting) => (
            <li key={meeting.id} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="font-medium text-slate-800">
                    {MEETING_TYPE_LABELS[meeting.meeting_type] ?? meeting.meeting_type} · {formatDateTime(meeting.starts_at)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    סטטוס: {MEETING_STATUS_LABELS[meeting.status] ?? meeting.status}
                    {meeting.meeting_url ? ` · ${meeting.meeting_url}` : ''}
                  </div>
                  {meeting.summary ? <div className="mt-1 text-xs text-slate-600">{meeting.summary}</div> : null}
                </div>
                {canUpdate && meeting.status === 'scheduled' ? (
                  <div className="flex flex-wrap gap-1">
                    <button type="button" className="kf-btn kf-btn-ghost text-xs" disabled={updating} onClick={() => onUpdate({ meetingId: meeting.id, status: 'held', note: 'הפגישה התקיימה' })}>התקיימה</button>
                    <button type="button" className="kf-btn kf-btn-ghost text-xs" disabled={updating} onClick={() => onUpdate({ meetingId: meeting.id, status: 'no_show', note: 'הלקוח לא הגיע לפגישה' })}>לא הגיע</button>
                    <button type="button" className="kf-btn kf-btn-ghost text-xs" disabled={updating} onClick={() => onUpdate({ meetingId: meeting.id, status: 'cancelled', note: 'הפגישה בוטלה' })}>בוטלה</button>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
      </ul>
    </div>
  );
}

function DealStageActions({
  deal,
  busy,
  onAdvance,
}: {
  deal: DealRow;
  busy: boolean;
  onAdvance: (deal: DealRow, targetStage: string) => void;
}) {
  const nextStages = NEXT_DEAL_STAGES[deal.track]?.[deal.stage] ?? [];
  if (!nextStages.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {nextStages.map((stage) => (
        <button
          key={stage}
          type="button"
          className="kf-btn kf-btn-ghost text-xs"
          disabled={busy}
          onClick={() => onAdvance(deal, stage)}
        >
          {DEAL_STAGE_LABELS[stage] ?? stage}
        </button>
      ))}
    </div>
  );
}

const NEXT_DEAL_STAGES: Record<string, Record<string, string[]>> = {
  program: {
    new: ['webinar_registered', 'phone_call_booked'],
    webinar_registered: ['webinar_attended', 'phone_call_booked'],
    webinar_attended: ['phone_call_booked', 'zoom_meeting', 'paid_program_member'],
    phone_call_booked: ['zoom_meeting', 'paid_program_member', 'not_relevant'],
    zoom_meeting: ['paid_program_member', 'not_relevant'],
  },
  presale: {
    new: ['phone_call_done', 'not_relevant'],
    phone_call_done: ['meeting_scheduled', 'not_relevant'],
    meeting_scheduled: ['office_meeting_held', 'not_relevant'],
    office_meeting_held: ['signed', 'not_relevant'],
  },
  investor_mentorship: {
    form_submitted: ['shahar_phone_call_done', 'not_relevant'],
    shahar_phone_call_done: ['zoom_meeting', 'not_relevant'],
    zoom_meeting: ['closed_won', 'not_relevant'],
  },
};

// Tier 7.C.1 — all 6 label maps consolidated to lib/format.ts.
// LeadDetailPage was the largest offender, with 5 local maps duplicating
// values used in PartnersPage, ProjectsPage, CommissionsPage, etc.

function formatConsent(value: boolean | null | undefined) {
  if (value === true) return 'כן';
  if (value === false) return 'לא';
  return null;
}

// Tier 6.B — ProductFocusStrip removed. It rendered a yellow card
// repeating product label + confidence + hint + suggested next
// action, all of which are shown by OperatorGuidanceCard and the
// סיווג ואבחון sidebar. Three copies of the same idea was the
// single biggest source of visual clutter on the page.

function leadResolutionGuide(
  lead: LeadDetailType,
  primaryAction: ReturnType<typeof operatorInsight>['primaryAction'],
): Array<{ title: string; when: string; action: string }> {
  const isOptOut = lead.do_not_contact || lead.removed_by_request;
  const isClosed = lead.lead_status === 'won' || lead.lead_status === 'lost' || isOptOut;

  if (isOptOut) {
    return [
      {
        title: 'לא לפנות יותר',
        when: 'הלקוח ביקש הסרה, חסימה או שלא יצרו איתו קשר.',
        action: 'להשאיר DNC/הוסר פעיל. לא לשלוח הודעה ולא להחזיר ל-AI.',
      },
      {
        title: 'חריג בלבד',
        when: 'רק אם הלקוח פונה מחדש בעצמו או שסימון DNC היה טעות.',
        action: 'בעלים/אדמין פותח מחדש במודע ומתעד סיבה.',
      },
    ];
  }

  if (isClosed) {
    return [
      {
        title: lead.lead_status === 'won' ? 'נסגר ברכישה' : 'סומן כאבוד',
        when: 'הסטטוס כבר סופי ואין משימה יומיומית לצוות.',
        action: 'לא לסגור שוב. לפתוח מחדש רק אם הלקוח חזר או שהסגירה הייתה טעות.',
      },
      {
        title: 'אם יש שיחה חדשה',
        when: 'לקוח סגור חזר עם שאלה, תמיכה או עניין מחודש.',
        action: 'לפתוח מחדש למסלול המתאים: responded / qualified / human_handoff.',
      },
    ];
  }

  return [
    {
      title: 'טופל',
      when: 'הלקוח קיבל מענה ברור, נקבעה פעולה הבאה, או שהמשימה כבר אינה דורשת אדם.',
      action: 'לסגור פריט תור עם הערה קצרה כדי שלא יקפוץ שוב.',
    },
    {
      title: 'להעביר לנציג',
      when: 'יש רגישות, התנגדות, בקשה אישית, תשלום, או צורך בשיקול דעת אנושי.',
      action: primaryAction === 'takeover' ? 'זו הפעולה המומלצת כרגע.' : 'ללחוץ “העברה לנציג” ולהשאיר סיכום קצר.',
    },
    {
      title: 'להחזיר ל-AI',
      when: 'הטיפול האנושי הסתיים ואין צורך בקשר אישי נוסף.',
      action: primaryAction === 'return_ai' ? 'זו הפעולה המומלצת כרגע.' : 'להחזיר ל-AI רק אחרי שההקשר ברור ובטוח.',
    },
    {
      title: 'לסגור / לסמן כאבוד',
      when: 'הלקוח לא רלוונטי, לא מתאים, ביקש לא לפנות, או אין המשך מסחרי.',
      action: 'לא להשאיר במעקב עמום: לסמן Lost או DNC לפי המקרה.',
    },
  ];
}

function operatorInsight(lead: LeadDetailType, queueItems: QueueRow[], messages: MessageRow[]) {
  const pendingQueues = queueItems.filter((q) => q.status === 'pending' || q.status === 'claimed');
  const failed = pendingQueues.find(
    (q) => q.queue_type === 'failed_automation' || q.queue_type === 'ai_stuck',
  );
  const phone =
    lead.ownership_mode === 'phone_sales_pending' ||
    pendingQueues.some((q) => q.queue_type === 'phone_escalation');
  const human = lead.ownership_mode === 'mia_active' || lead.lead_status === 'human_handoff';
  const ai = lead.ownership_mode === 'ai_active';
  const last = messages[messages.length - 1];
  const lastFromLead = last?.sender_type === 'lead';
  const lastText = last?.content_text?.trim();
  const closed =
    lead.lead_status === 'won' ||
    lead.lead_status === 'lost' ||
    lead.do_not_contact ||
    lead.removed_by_request;
  const classificationWhy = lead.classification_summary || lead.handoff_reason || lead.suggested_next_action;
  const humanScript = lead.suggested_next_action || 'עני קצר, ברור ובגובה העיניים; סיימי בשאלה אחת שמקדמת לשלב הבא.';

  if (closed) {
    return {
      title: 'הליד סגור — לא נדרשת פעולה יומיומית',
      detail: 'אם הלקוח חזר או שהסגירה הייתה טעות, השתמשי בפתיחה מחדש. אחרת אין צורך לגעת.',
      why: lead.lost_reason || lead.payment_status || 'הסטטוס הנוכחי הוא סופי או חסום ליצירת קשר.',
      script: 'לא לשלוח הודעה חדשה אלא אם הליד נפתח מחדש במודע.',
      ownerLine: 'מצב סגור',
      primaryAction: null,
      tone: 'border-slate-200 bg-slate-50 text-slate-800',
    };
  }
  if (failed) {
    return {
      title: 'יש תקלה שמונעת טיפול אוטומטי',
      detail: failed.reason ?? 'נוצר פריט תקלה. כדאי לפתוח את השיחה ולענות ידנית או לבדוק את שליחת WhatsApp.',
      why: failed.reason ?? 'יש פריט תור פתוח שמסמן שהאוטומציה לא השלימה טיפול.',
      script: lastText ? `להתייחס להודעה האחרונה: “${lastText.slice(0, 120)}”` : humanScript,
      ownerLine: 'דורש בדיקה ידנית',
      primaryAction: 'takeover' as const,
      tone: 'border-rose-200 bg-rose-50 text-rose-950',
    };
  }
  if (phone) {
    return {
      title: 'השלב הנכון הוא שיחת טלפון',
      detail: 'הליד ביקש שיחה או זוהה ככזה שצריך התערבות טלפונית. אחרי השיחה תעדי תוצאה וסיכום קצר.',
      why: classificationWhy || 'הליד חם או דורש מענה אישי מהיר, ולכן שיחה עדיפה על עוד הודעות.',
      script: 'להתקשר, לפתוח בשאלה קצרה על הצורך שלו, ואז לתעד תוצאה: ענה / לא ענה / נקבע המשך.',
      ownerLine: 'ממתין לשיחה',
      primaryAction: 'phone' as const,
      tone: 'border-indigo-200 bg-indigo-50 text-indigo-950',
    };
  }
  if (human && lastFromLead) {
    return {
      title: 'הלקוח מחכה לתשובה ממך',
      detail: 'ה-AI מושעה בזמן טיפול אנושי. עני מהתיבה למטה, או החזירי ל-AI אם אין צורך במענה אנושי.',
      why: classificationWhy || 'ההודעה האחרונה הגיעה מהלקוח בזמן שהשיחה בבעלות אנושית.',
      script: humanScript,
      ownerLine: 'בטיפול אנושי',
      primaryAction: 'return_ai' as const,
      tone: 'border-amber-200 bg-amber-50 text-amber-950',
    };
  }
  if (human) {
    return {
      title: 'הליד אצלך — החליטי אם להמשיך ידנית או להחזיר ל-AI',
      detail: 'אם סיימת טיפול, החזרה ל-AI תחזיר את המענה האוטומטי. אם צריך קשר אישי — המשיכי לענות ידנית.',
      why: classificationWhy || 'השיחה כבר נלקחה לטיפול אנושי ולכן ה-AI לא ממשיך לבד.',
      script: 'אם אין צורך בטיפול אישי נוסף — להחזיר למענה אוטומטי. אם יש צורך — לענות ידנית ולתעד.',
      ownerLine: 'בטיפול אנושי',
      primaryAction: 'return_ai' as const,
      tone: 'border-amber-200 bg-amber-50 text-amber-950',
    };
  }
  if (ai) {
    return {
      title: 'ה-AI מטפל — רק לעקוב',
      detail: 'אין צורך להתערב כרגע. אם את מזהה שיחה רגישה, אפשר לקחת לטיפול אנושי בלחיצה.',
      why: classificationWhy || 'השיחה נמצאת בבעלות AI ואין כרגע סימן שמחייב התערבות אדם.',
      script: 'לא לענות ידנית כרגע. אם משהו נראה רגיש או שגוי — לקחת לטיפול אנושי ואז לענות.',
      ownerLine: 'AI פעיל',
      primaryAction: 'takeover' as const,
      tone: 'border-sky-200 bg-sky-50 text-sky-950',
    };
  }
  return {
    title: 'צריך לבדוק מי אחראי על הליד',
    detail: 'מצב הבעלות לא חד־משמעי. מומלץ לקחת לטיפול ידני ולסגור את ההחלטה.',
    why: classificationWhy || 'מצב הבעלות לא תואם מסלול עבודה ברור.',
    script: humanScript,
    ownerLine: `בעלות: ${lead.ownership_mode}`,
    primaryAction: 'takeover' as const,
    tone: 'border-slate-200 bg-white text-slate-900',
  };
}

function ActionGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/50 p-1.5">
      <span className="w-full px-2 text-xs text-slate-500 sm:w-auto">{label}</span>
      {children}
    </div>
  );
}

function NextActionBadge({ actionType, dueAt }: { actionType: string | null; dueAt: string | null }) {
  if (!actionType && !dueAt) return null;
  const dueMs = dueAt ? Date.parse(dueAt) : NaN;
  const overdue = Number.isFinite(dueMs) && dueMs < Date.now();
  const tone = overdue
    ? 'bg-rose-100 text-rose-800 ring-1 ring-inset ring-rose-200'
    : 'bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200';
  return (
    <span
      className={clsx('kf-badge', tone)}
      title={dueAt ? new Date(dueAt).toLocaleString('he-IL') : undefined}
      aria-live={overdue ? 'polite' : undefined}
    >
      {overdue ? '⚠️ ' : '⏭ '}
      {actionType ? `הבא: ${actionType}` : 'הבא'}
      {dueAt ? ` · ${formatRelative(dueAt)}` : ''}
      {overdue ? ' · באיחור' : ''}
    </span>
  );
}

function HandlerBanner({
  ownership,
  lastHumanTouchAt,
}: {
  ownership: import('@/lib/types').OwnershipMode;
  lastHumanTouchAt: string | null;
}) {
  const cfg = (() => {
    switch (ownership) {
      case 'ai_active':
        return {
          tone: 'bg-violet-50 text-violet-800 ring-violet-200',
          icon: '🤖',
          label: 'AI מטפל בליד',
          detail: 'הבוט עונה אוטומטית להודעות נכנסות.',
        };
      case 'mia_active':
        return {
          tone: 'bg-amber-50 text-amber-800 ring-amber-200',
          icon: '👤',
          label: 'נציג מטפל',
          detail: lastHumanTouchAt
            ? `מגע אנושי אחרון ${formatRelative(lastHumanTouchAt)}`
            : 'הליד הועבר לטיפול ידני.',
        };
      case 'phone_sales_pending':
        return {
          tone: 'bg-orange-50 text-orange-800 ring-orange-200',
          icon: '📞',
          label: 'ממתין לשיחת טלפון',
          detail: 'הליד סומן להתקשרות יזומה.',
        };
      case 'shared_watch':
        return {
          tone: 'bg-slate-100 text-slate-700 ring-slate-200',
          icon: '👁️',
          label: 'במעקב משותף',
          detail: 'אין מטפל פעיל; הצוות עוקב.',
        };
      case 'suppressed':
        return {
          tone: 'bg-rose-50 text-rose-800 ring-rose-200',
          icon: '🚫',
          label: 'ליד מנותק',
          detail: 'לא נשלחות הודעות אוטומטיות.',
        };
      default:
        return {
          tone: 'bg-slate-100 text-slate-700 ring-slate-200',
          icon: '•',
          label: ownership,
          detail: '',
        };
    }
  })();
  return (
    <div
      className={clsx(
        'sticky top-0 z-10 mt-3 flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium ring-1 ring-inset',
        cfg.tone,
      )}
      aria-live="polite"
    >
      <span aria-hidden="true" className="text-base leading-none">
        {cfg.icon}
      </span>
      <span>{cfg.label}</span>
      {cfg.detail ? <span className="text-xs font-normal opacity-80">· {cfg.detail}</span> : null}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string | null | undefined }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <dt className="col-span-1 text-slate-500">{k}</dt>
      <dd className="col-span-2 text-slate-800">{v || '—'}</dd>
    </div>
  );
}

function EditableRow({
  k,
  v,
  editable,
  saving = false,
  onSave,
}: {
  k: string;
  v: string | null | undefined;
  editable: boolean;
  saving?: boolean;
  onSave: (next: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(v ?? '');

  useEffect(() => {
    if (!editing) setDraft(v ?? '');
  }, [v, editing]);

  // While a save is in-flight, exit edit mode so the row goes back to display
  // with a spinner overlay; on success the parent invalidates the query.
  useEffect(() => {
    if (saving) setEditing(false);
  }, [saving]);

  if (!editable) return <Row k={k} v={v} />;

  if (!editing) {
    return (
      <div className={clsx('grid grid-cols-3 items-center gap-2', saving && 'opacity-60')}>
        <dt className="col-span-1 text-slate-500">{k}</dt>
        <dd className="col-span-2 flex items-center gap-2 text-slate-800">
          <span className="min-w-0 flex-1 truncate">{v || '—'}</span>
          {saving ? (
            <span className="inline-flex items-center gap-1 text-xs text-slate-500" aria-live="polite">
              <svg
                viewBox="0 0 20 20"
                className="h-3 w-3 animate-spin"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M10 2a8 8 0 1 1-8 8" strokeLinecap="round" />
              </svg>
              שומר...
            </span>
          ) : (
            <button
              type="button"
              className="text-xs text-brand-700 hover:underline"
              onClick={() => setEditing(true)}
            >
              עריכה
            </button>
          )}
        </dd>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-3 items-center gap-2">
      <dt className="col-span-1 text-slate-500">{k}</dt>
      <dd className="col-span-2 flex items-center gap-2">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="kf-input text-sm"
          maxLength={280}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
            if (e.key === 'Enter') {
              const next = draft.trim();
              onSave(next.length ? next : null);
            }
          }}
        />
        <button
          type="button"
          className="kf-btn kf-btn-primary text-xs"
          onClick={() => {
            const next = draft.trim();
            onSave(next.length ? next : null);
          }}
        >
          שמירה
        </button>
        <button type="button" className="kf-btn text-xs" onClick={() => setEditing(false)}>
          ביטול
        </button>
      </dd>
    </div>
  );
}

function EditableEnumRow({
  k,
  v,
  editable,
  options,
  onSave,
}: {
  k: string;
  v: string | null | undefined;
  editable: boolean;
  options: Array<{ value: string; label: string }>;
  onSave: (next: string | null) => void;
}) {
  const display = options.find((o) => o.value === v)?.label ?? v ?? '—';
  if (!editable) return <Row k={k} v={display} />;
  return (
    <div className="grid grid-cols-3 items-center gap-2">
      <dt className="col-span-1 text-slate-500">{k}</dt>
      <dd className="col-span-2 flex items-center gap-2 text-slate-800">
        {/* Native select wins here over a custom popover — Mia uses this on
            mobile a lot, and native pickers behave correctly with the OS
            keyboard + screen reader without extra a11y wiring. */}
        <select
          value={v ?? ''}
          className="kf-input text-sm"
          onChange={(e) => {
            const next = e.target.value;
            onSave(next.length ? next : null);
          }}
        >
          <option value="">— ללא —</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </dd>
    </div>
  );
}

function DataRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-slate-500">{label}:</span>
      <strong className="text-slate-800">{value || '—'}</strong>
    </div>
  );
}

function ContactRow({
  label,
  value,
  kind,
}: {
  label: string;
  value: string | null | undefined;
  kind: 'phone' | 'email';
}) {
  const toast = useToast();
  if (!value) {
    return (
      <div className="flex items-baseline gap-2">
        <span className="text-slate-500">{label}:</span>
        <strong className="text-slate-800">—</strong>
      </div>
    );
  }
  const href = kind === 'phone' ? `tel:${value}` : `mailto:${value}`;
  function copy() {
    navigator.clipboard?.writeText(value!).then(
      () => toast.success(`${label} הועתק`),
      () => toast.error('העתקה נכשלה'),
    );
  }
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-slate-500">{label}:</span>
      <a href={href} className="font-medium text-slate-800 hover:text-brand-700 hover:underline tabular-nums">
        {value}
      </a>
      <button
        type="button"
        onClick={copy}
        className="text-slate-400 transition hover:text-brand-600"
        aria-label={`העתקת ${label}`}
        title={`העתקת ${label}`}
      >
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7">
          <rect x="6" y="6" width="10" height="10" rx="1.5" />
          <path d="M4 13V5a1 1 0 0 1 1-1h8" />
        </svg>
      </button>
    </div>
  );
}

const INQUIRY_OPTIONS: Array<{ value: InquiryType; label: string }> = [
  { value: 'program_details', label: 'פרטי תוכנית' },
  { value: 'pricing', label: 'מחיר' },
  { value: 'financing', label: 'מימון/משכנתא' },
  { value: 'eligibility', label: 'התאמה' },
  { value: 'property_search', label: 'איתור עסקה/נכס' },
  { value: 'mentorship', label: 'ליווי' },
  { value: 'purchase_ready', label: 'רכישה עכשיו' },
  { value: 'support', label: 'תמיכה/לקוח קיים' },
  { value: 'unknown', label: 'לא ידוע' },
];

const PRODUCT_OPTIONS: Array<{ value: ProductInterest; label: string }> = [
  { value: 'digital_program', label: 'תוכנית הדרך לדירה' },
  { value: 'investor_mentorship', label: 'ליווי משקיעים' },
  { value: 'contractor_group_purchase', label: 'קבוצת רכישה מקבלן' },
  { value: 'personal_consultation', label: 'שיחת ייעוץ אישית' },
  { value: 'unknown', label: 'לא ידוע' },
];



const SEGMENT_OPTIONS: Array<{ value: IntakeSegment; label: string }> = [
  { value: 'hot_sales', label: 'מכירה חמה' },
  { value: 'needs_human', label: 'נציג אנושי' },
  { value: 'needs_nurture', label: 'טיפוח/הבשלה' },
  { value: 'info_seeker', label: 'מחפש מידע' },
  { value: 'support_or_existing', label: 'תמיכה/קיים' },
  { value: 'unknown', label: 'לא ידוע' },
];

const CLASSIFICATION_CONFIDENCE_LABELS: Record<'high' | 'medium' | 'low', string> = {
  high: 'גבוה',
  medium: 'בינוני',
  low: 'נמוך',
};


function waLink(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '').replace(/^\+/, '');
  return `https://wa.me/${digits}`;
}

function CallLogForm({
  onSubmit,
  submitting,
  errorMessage,
}: {
  onSubmit: (outcome: CallOutcome, durationMinutes: number, note: string | null) => void;
  submitting: boolean;
  errorMessage: string | null;
}) {
  const [outcome, setOutcome] = useState<CallOutcome>('connected');
  const [duration, setDuration] = useState<string>('5');
  const [note, setNote] = useState('');

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const minutes = Math.max(0, Number(duration) || 0);
    onSubmit(outcome, minutes, note.trim() || null);
    setNote('');
    setDuration('5');
  }

  return (
    <form onSubmit={submit} className="mt-2 space-y-2 text-sm">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="text-slate-600">תוצאה</span>
          <select
            className="kf-input mt-1"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as CallOutcome)}
          >
            <option value="connected">התקיימה שיחה</option>
            <option value="no_answer">אין מענה</option>
            <option value="voicemail">תא קולי</option>
            <option value="declined">סירב לדבר</option>
            <option value="callback_requested">ביקש שנחזור</option>
          </select>
        </label>
        <label className="block">
          <span className="text-slate-600">משך (דק׳)</span>
          <input
            type="number"
            min={0}
            max={180}
            className="kf-input mt-1"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </label>
      </div>
      <textarea
        className="kf-input min-h-[64px]"
        placeholder="סיכום השיחה והצעדים הבאים..."
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button type="submit" className="kf-btn kf-btn-primary w-full sm:w-auto" disabled={submitting}>
        {submitting ? 'שומר...' : 'שמירת שיחה'}
      </button>
      {errorMessage ? <p className="text-rose-600">{errorMessage}</p> : null}
    </form>
  );
}

function ReplyBox({
  disabled,
  onSend,
  sending,
  errorMessage,
  lead,
  channel = 'whatsapp',
}: {
  disabled: boolean;
  onSend: (text: string) => void;
  sending: boolean;
  errorMessage: string | null;
  // Tier 2.D — needed so the template renderer can expand
  // {{first_name}} and other markers against the actual contact
  // when Mia inserts a template into the reply.
  lead: { full_name: string | null; phone: string | null; email: string | null; city: string | null };
  // Tier 8.A — conversation channel; Instagram hides the WhatsApp
  // template picker and gets its own 24h-window copy (IG has no
  // template fallback — late replies queue until the next inbound).
  channel?: string;
}) {
  const [text, setText] = useState('');

  // Lazy fetch active WA templates only when the picker drawer opens.
  // Keeps the lead detail page's initial render light.
  const [pickerOpen, setPickerOpen] = useState(false);
  const templatesQ = useQuery({
    queryKey: ['templates', 'whatsapp', 'active'],
    queryFn: () => fetchMessageTemplates({ channel: 'whatsapp', status: 'active' }),
    enabled: pickerOpen,
  });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!text.trim() || disabled) return;
    onSend(text.trim());
    setText('');
  }

  function insertTemplate(template: MessageTemplateRow) {
    const ctx = contextFromLead(lead);
    const { text: rendered } = renderTemplate(template.body, ctx);
    setText(rendered);
    setPickerOpen(false);
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-2">
      <textarea
        className="kf-input min-h-[88px]"
        placeholder={disabled ? 'לא ניתן לשלוח (ליד מושתק או חסרה שיחה).' : 'הקלד תשובה ידנית...'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
      />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="flex items-center gap-2 text-xs">
          {channel !== 'instagram' ? (
            <button type="button" className="kf-btn text-xs" disabled={disabled}
              onClick={() => setPickerOpen((open) => !open)}>
              {pickerOpen ? 'סגור תבניות' : '+ הכנס תבנית'}
            </button>
          ) : null}
          <span className="text-slate-500">
            {channel === 'instagram'
              ? 'ייצא דרך אינסטגרם. מחוץ לחלון 24 שעות ההודעה תמתין עד שהלקוח יכתוב שוב.'
              : 'ייצא דרך WhatsApp. מחוץ לחלון 24 שעות תישלח תבנית.'}
          </span>
        </div>
        <button
          type="submit"
          className="kf-btn kf-btn-primary w-full sm:w-auto"
          disabled={disabled || sending || !text.trim()}
        >
          {sending ? 'שולח...' : 'שליחה'}
        </button>
      </div>
      {pickerOpen ? (
        <div className="max-h-64 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2">
          {templatesQ.isLoading ? <p className="text-xs text-slate-500">טוען תבניות...</p> :
            templatesQ.data?.templates.length ? (
              <ul className="space-y-1">
                {templatesQ.data.templates.map((tpl) => (
                  <li key={tpl.id}>
                    <button type="button" className="w-full rounded-md p-2 text-right text-sm hover:bg-white"
                      onClick={() => insertTemplate(tpl)}>
                      <div className="font-medium">{tpl.name_he}</div>
                      <div className="mt-0.5 truncate text-xs text-slate-500">{tpl.body}</div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="text-xs text-slate-500">אין תבניות פעילות. אפשר להוסיף ב-/templates.</p>}
        </div>
      ) : null}
      {errorMessage ? <p className="text-sm text-rose-600">{errorMessage}</p> : null}
    </form>
  );
}

// ── Current owner line (P2 — operator clarity) ───────────────────────────
// Singular source of truth on the question "who is responsible RIGHT NOW
// for this lead?". Combines ownership_mode + the human profile (when
// applicable) into one Hebrew line, color-coded by who owns it.
//
// Why this matters: Mia reported that after an AI→human handoff, the
// next step was unclear ("did anyone catch this?"). Surfacing the
// owner prominently — including when AI is the active owner — closes
// the visibility gap that was costing leads.
// Tier 6.B — CurrentOwnerLine removed. It rendered a colored banner
// saying "🤖 AI is handling" with an explanation subtitle. The
// OwnershipBadge chip + HandlerBanner (the one directly above the
// timeline) already say this — twice — so the colored banner was a
// third repetition.

// ── Tier 4.C — per-contact automation + journey history ─────────────────
//
// Two lazy queries: automation_runs and journey_runs scoped to this
// contact. Renders a compact summary so Mia can quickly check
// "what did the engine do for this person?" without opening
// /automations and filtering.
function AutomationHistoryCard({ contactId }: { contactId: string }) {
  const runsQ = useQuery({
    queryKey: ['automation-runs', contactId],
    queryFn: () => fetchAutomationRunsForContact(contactId),
    staleTime: 60_000,
  });
  const journeysQ = useQuery({
    queryKey: ['journey-runs', contactId],
    queryFn: () => fetchJourneyRunsForContact(contactId),
    staleTime: 60_000,
  });

  const runs = runsQ.data?.runs ?? [];
  const journeys = journeysQ.data?.runs ?? [];

  if (runs.length === 0 && journeys.length === 0 && !runsQ.isLoading && !journeysQ.isLoading) {
    // Don't render the card at all if neither pane has anything to show —
    // the sidebar already has enough chrome.
    return null;
  }

  return (
    <div className="kf-card p-4">
      <h2 className="font-semibold">היסטוריית אוטומציה</h2>
      {/* Tier 5 polish — journey rows + automation rows linkable to
          their definitions for one-click drill-down. */}
      {journeys.length > 0 ? (
        <div className="mt-2">
          <h3 className="text-xs font-medium text-slate-500">מסעות לקוח</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {journeys.map((j) => (
              <li key={j.id}>
                <Link to="/journeys" className="flex items-baseline justify-between gap-2 rounded-md p-1 hover:bg-slate-50">
                  <span className="truncate">
                    <strong>{j.definition?.name_he ?? j.definition_code}</strong>
                    <span className="text-slate-500"> · שלב {j.current_step + 1}</span>
                  </span>
                  <span className={
                    j.status === 'active' ? 'text-xs text-sky-700' :
                    j.status === 'completed' ? 'text-xs text-emerald-700' :
                    j.status === 'failed' ? 'text-xs text-rose-700' : 'text-xs text-slate-500'
                  }>{j.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {runs.length > 0 ? (
        <div className="mt-3">
          <h3 className="text-xs font-medium text-slate-500">הרצות אחרונות ({runs.length})</h3>
          <ul className="mt-1 max-h-44 overflow-auto text-xs">
            {runs.slice(0, 12).map((r) => (
              <li key={r.id}>
                <Link to="/automations" className="flex items-baseline justify-between gap-2 rounded-md p-1 py-0.5 hover:bg-slate-50">
                  <code className="truncate text-slate-700">{r.rule_code}</code>
                  <span className="flex items-center gap-1 text-slate-500">
                    <span className={
                      r.status === 'success' ? 'text-emerald-700' :
                      r.status === 'failed' ? 'text-rose-700' :
                      r.status === 'partial' ? 'text-amber-700' : 'text-slate-500'
                    }>{r.status}</span>
                    <span title={r.created_at}>{formatRelative(r.created_at)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
