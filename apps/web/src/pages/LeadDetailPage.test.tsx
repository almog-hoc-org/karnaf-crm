import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext, type AuthState, type Role } from '@/auth/auth-context';
import type { ConversationRow, LeadDetail, MeetingRow, MessageRow, QueueRow, TaskRow, EventRow } from '@/lib/types';
import { LeadDetailPage } from './LeadDetailPage';

vi.mock('@/lib/api', () => ({
  fetchLeadDetail: vi.fn(),
  postAdminAction: vi.fn(),
  postSendReply: vi.fn(),
  postQueueResolve: vi.fn(),
}));

import { fetchLeadDetail, postAdminAction, postSendReply, postQueueResolve } from '@/lib/api';

const lead: LeadDetail = {
  id: 'lead-1',
  full_name: 'דנה כהן',
  phone: '+972500000001',
  email: 'dana@example.com',
  source: 'whatsapp',
  lead_status: 'qualified',
  lead_heat: 'hot',
  ownership_mode: 'ai_active',
  lead_score: 80,
  payment_status: null,
  last_message_at: '2026-04-28T10:00:00Z',
  last_inbound_at: '2026-04-28T09:55:00Z',
  last_outbound_at: '2026-04-28T09:50:00Z',
  do_not_contact: false,
  removed_by_request: false,
  updated_at: '2026-04-28T10:00:00Z',
  created_at: '2026-04-27T08:00:00Z',
  source_detail: null,
  source_campaign: null,
  webinar_name: null,
  conversation_summary: null,
  pain_point_summary: null,
  goal_summary: 'דירה ראשונה',
  main_blocker: null,
  notes_internal: null,
  estimated_equity: null,
  next_action_type: null,
  next_action_due_at: null,
  payment_completed_at: null,
  won_at: null,
  lost_at: null,
  lost_reason: null,
  decision_context: null,
  city: null,
  lead_fit: null,
  readiness_level: null,
  human_owner_id: null,
  requested_phone_call: false,
  last_human_touch_at: null,
  ai_playbook_stage: null,
  ai_playbook_stage_at: null,
  inquiry_type: 'program_details',
  product_interest: 'digital_program',
  intake_segment: 'info_seeker',
  classification_confidence: 'medium',
  classification_summary: 'סיווג: פרטי תוכנית · מוצר: תוכנית דיגיטלית · מסלול טיפול: מחפש מידע',
  suggested_next_action: 'לתת תשובה קצרה ולשאול שאלת אבחון אחת.',
  handoff_reason: null,
  classification_updated_at: '2026-04-28T10:00:00Z',
};

const conversation: ConversationRow = {
  id: 'conv-1',
  lead_id: 'lead-1',
  channel: 'whatsapp',
  ownership_mode: 'ai_active',
  is_open: true,
  last_activity_at: '2026-04-28T10:00:00Z',
};

const messages: MessageRow[] = [
  {
    id: 'm1',
    lead_id: 'lead-1',
    conversation_id: 'conv-1',
    provider_message_id: null,
    sender_type: 'lead',
    sender_name: 'דנה',
    direction: 'inbound',
    message_type: 'text',
    content_text: 'שלום, אשמח לפרטים',
    provider_status: null,
    provider_error: null,
    delivered_at: null,
    read_at: null,
    created_at: '2026-04-28T09:30:00Z',
  },
  {
    id: 'm2',
    lead_id: 'lead-1',
    conversation_id: 'conv-1',
    provider_message_id: 'wa-1',
    sender_type: 'ai',
    sender_name: 'AI',
    direction: 'outbound',
    message_type: 'text',
    content_text: 'היי דנה, נשמח לעזור.',
    provider_status: 'delivered',
    provider_error: null,
    delivered_at: '2026-04-28T09:31:00Z',
    read_at: null,
    created_at: '2026-04-28T09:31:00Z',
  },
];

// Tier 0.F.1 — UnifiedTimeline reads from `activities` rather than the
// individual messages/events/tasks/queue arrays. Mirror the test's two
// outbound/inbound messages into activities so the timeline can render.
const activities: import('@/lib/types').ActivityRow[] = [
  {
    id: 'a1',
    contact_id: 'lead-1',
    occurred_at: '2026-04-28T09:30:00Z',
    activity_type: 'message',
    actor_type: 'lead',
    conversation_id: 'conv-1',
    deal_id: null,
    meeting_id: null,
    actor_user_id: null,
    title: 'דנה',
    body: 'שלום, אשמח לפרטים',
    status: null,
    priority_level: null,
    due_at: null,
    completed_at: null,
    direction: 'inbound',
    source_table: 'messages',
    source_id: 'm1',
    payload: {},
    created_at: '2026-04-28T09:30:00Z',
  },
  {
    id: 'a2',
    contact_id: 'lead-1',
    occurred_at: '2026-04-28T09:31:00Z',
    activity_type: 'message',
    actor_type: 'ai',
    conversation_id: 'conv-1',
    deal_id: null,
    meeting_id: null,
    actor_user_id: null,
    title: 'AI',
    body: 'היי דנה, נשמח לעזור.',
    status: null,
    priority_level: null,
    due_at: null,
    completed_at: null,
    direction: 'outbound',
    source_table: 'messages',
    source_id: 'm2',
    payload: { provider_message_id: 'wa-1', provider_status: 'delivered' },
    created_at: '2026-04-28T09:31:00Z',
  },
  // A system event — must render in the "פעילות" tab only, never
  // between the chat bubbles.
  {
    id: 'a3',
    contact_id: 'lead-1',
    occurred_at: '2026-04-28T09:32:00Z',
    activity_type: 'event',
    actor_type: 'system',
    conversation_id: 'conv-1',
    deal_id: null,
    meeting_id: null,
    actor_user_id: null,
    title: 'sla_breach',
    body: null,
    status: null,
    priority_level: null,
    due_at: null,
    completed_at: null,
    direction: null,
    source_table: 'lead_events',
    source_id: 'e1',
    payload: {},
    created_at: '2026-04-28T09:32:00Z',
  },
];

const queueItems: QueueRow[] = [
  {
    id: 'q1',
    lead_id: 'lead-1',
    queue_type: 'hot_lead',
    priority_level: 90,
    status: 'pending',
    reason: 'high score',
    queue_summary: null,
    due_at: null,
    created_at: '2026-04-28T09:00:00Z',
    resolution_note: null,
  },
];

const tasks: TaskRow[] = [
  {
    id: 't1',
    lead_id: 'lead-1',
    task_type: 'follow_up',
    task_status: 'open',
    owner_type: 'mia',
    title: 'מעקב',
    description: null,
    priority_level: 50,
    due_at: null,
    created_at: '2026-04-28T09:00:00Z',
  },
];

const meetings: MeetingRow[] = [
  {
    id: 'meeting-1',
    lead_id: 'lead-1',
    deal_id: null,
    meeting_type: 'zoom',
    starts_at: '2026-06-09T10:30:00Z',
    ends_at: '2026-06-09T11:00:00Z',
    assigned_to_user_id: 'admin-1',
    status: 'scheduled',
    summary: 'שיחת התאמה ראשונה',
    calendar_event_id: null,
    meeting_url: 'https://example.com/zoom',
    created_at: '2026-06-08T08:00:00Z',
    updated_at: '2026-06-08T08:00:00Z',
  },
];

const events: EventRow[] = [
  {
    id: 'e1',
    lead_id: 'lead-1',
    conversation_id: 'conv-1',
    event_type: 'lead_created',
    actor_type: 'system',
    event_payload: {},
    created_at: '2026-04-27T08:00:00Z',
  },
];

function makeAuth(role: Role | null = 'admin'): AuthState {
  const fakeUser = { id: 'admin-1', email: 'admin@karnaf.io' } as unknown as AuthState['user'];
  const fakeSession = { user: fakeUser } as unknown as AuthState['session'];
  return {
    session: fakeSession,
    user: fakeUser,
    role,
    loading: false,
    signIn: async () => ({ error: null }),
    signInWithGoogle: async () => ({ error: null }),
    signUp: async () => ({ error: null, needsEmailConfirmation: true }),
    signOut: async () => {},
  };
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function renderDetail(role: Role | null = 'admin') {
  return render(
    <QueryClientProvider client={makeClient()}>
      <AuthContext.Provider value={makeAuth(role)}>
        <MemoryRouter initialEntries={['/leads/lead-1']}>
          <Routes>
            <Route path="/leads/:leadId" element={<LeadDetailPage />} />
            <Route path="/leads" element={<div>leads list</div>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(fetchLeadDetail).mockResolvedValue({
    ok: true,
    lead,
    conversations: [conversation],
    messages,
    activities,
    queueItems,
    tasks,
    events,
    meetings,
    humanOwnerProfile: null,
  });
  vi.mocked(postAdminAction).mockResolvedValue({ ok: true, action: 'noop' });
  vi.mocked(postSendReply).mockResolvedValue({ ok: true, mode: 'freeform' });
  vi.mocked(postQueueResolve).mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('LeadDetailPage', () => {
  it('renders the lead header, transcript, and the back link to the list', async () => {
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'דנה כהן' })).toBeInTheDocument();
    expect(screen.getByText('ה-AI מטפל — רק לעקוב')).toBeInTheDocument();
    expect(screen.getByText('למה זה כאן')).toBeInTheDocument();
    expect(screen.getByText('מה להגיד עכשיו')).toBeInTheDocument();
    // Tier 6.B — ProductFocusStrip removed; product label is now shown
    // by OperatorGuidanceCard + the סיווג ואבחון sidebar card.
    expect(screen.getAllByText('תוכנית הדרך לדירה').length).toBeGreaterThan(0);
    expect(screen.getAllByText('לתת תשובה קצרה ולשאול שאלת אבחון אחת.').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'לקחת לטיפול אנושי' })).toBeInTheDocument();
    expect(screen.getByText('היי דנה, נשמח לעזור.')).toBeInTheDocument();
    expect(screen.getByText('שלום, אשמח לפרטים')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← חזרה לרשימה' })).toHaveAttribute('href', '/leads');
  });

  it('keeps system events out of the chat pane and shows them in the activity tab', async () => {
    renderDetail();
    // Chat tab (default): bubbles yes, event no.
    expect(await screen.findByText('שלום, אשמח לפרטים')).toBeInTheDocument();
    expect(screen.queryByText('חריגת זמן מענה')).not.toBeInTheDocument();
    // Switch to the activity tab: event visible (labeled Hebrew), bubbles gone.
    fireEvent.click(screen.getByRole('tab', { name: /פעילות/ }));
    expect(await screen.findByText('חריגת זמן מענה')).toBeInTheDocument();
    expect(screen.queryByText('שלום, אשמח לפרטים')).not.toBeInTheDocument();
    // Back to chat.
    fireEvent.click(screen.getByRole('tab', { name: 'שיחה' }));
    expect(await screen.findByText('שלום, אשמח לפרטים')).toBeInTheDocument();
  });

  it('invokes mark_won after confirming the action dialog', async () => {
    renderDetail();
    // Tier 5.D — lifecycle buttons live inside "פעולות נוספות" disclosure.
    fireEvent.click(await screen.findByText('פעולות נוספות'));
    fireEvent.click(await screen.findByRole('button', { name: 'סימון כסגירה' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'אישור' }));
    await waitFor(() => {
      expect(postAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'mark_won',
          leadId: 'lead-1',
        }),
      );
    });
  });

  it('invokes mark_lost with manual_close note after confirming dialog', async () => {
    renderDetail();
    fireEvent.click(await screen.findByText('פעולות נוספות'));
    fireEvent.click(await screen.findByRole('button', { name: 'סימון כאבוד' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'אישור' }));
    await waitFor(() => {
      expect(postAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'mark_lost',
          leadId: 'lead-1',
          note: 'manual_close',
        }),
      );
    });
  });

  it('cancel button on the confirm dialog does not fire the action', async () => {
    renderDetail();
    // Tier 5.D — lifecycle buttons are now inside a "פעולות נוספות"
    // <details> disclosure. Expand it before reaching the DNC button.
    fireEvent.click(await screen.findByText('פעולות נוספות'));
    fireEvent.click(await screen.findByRole('button', { name: 'סימון כ-DNC' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'ביטול' }));
    expect(postAdminAction).not.toHaveBeenCalled();
  });

  it('sends a manual reply with trimmed text and clears the textarea afterward', async () => {
    renderDetail();
    const textarea = await screen.findByPlaceholderText('הקלד תשובה ידנית...');
    fireEvent.change(textarea, { target: { value: '  שלום, מתי נוח לך?  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'שליחה' }));
    await waitFor(() => {
      expect(postSendReply).toHaveBeenCalledWith({
        leadId: 'lead-1',
        conversationId: 'conv-1',
        text: 'שלום, מתי נוח לך?',
      });
    });
    expect(textarea).toHaveValue('');
  });

  it('disables the reply box when the lead is marked do_not_contact', async () => {
    vi.mocked(fetchLeadDetail).mockResolvedValue({
      ok: true,
      lead: { ...lead, do_not_contact: true },
      conversations: [conversation],
      messages,
    activities,
      queueItems,
      tasks,
      events,
      humanOwnerProfile: null,
    });
    renderDetail();
    const textarea = await screen.findByPlaceholderText('לא ניתן לשלוח (ליד מושתק או חסרה שיחה).');
    expect(textarea).toBeDisabled();
    expect(screen.getByRole('button', { name: 'שליחה' })).toBeDisabled();
  });

  it('opens the reopen dialog from DNC and sends a targetStatus', async () => {
    vi.mocked(fetchLeadDetail).mockResolvedValue({
      ok: true,
      lead: { ...lead, lead_status: 'do_not_contact', do_not_contact: true },
      conversations: [conversation],
      messages,
    activities,
      queueItems,
      tasks,
      events,
      humanOwnerProfile: null,
    });
    renderDetail('owner');
    fireEvent.click(await screen.findByRole('button', { name: 'פתח שיחה מחדש' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'פתיחה מחדש' }));
    await waitFor(() => {
      expect(postAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'reopen_lead',
          leadId: 'lead-1',
          targetStatus: 'responded',
        }),
      );
    });
  });

  it('resolves a pending queue item via the close confirmation dialog', async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'סגירה' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = await waitFor(
      () => screen.getAllByRole('button', { name: 'סגירה' }).find((el) => dialog.contains(el))!,
    );
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(postQueueResolve).toHaveBeenCalledWith({
        queueItemId: 'q1',
        resolutionNote: null,
      });
    });
  });

  it('logs a phone call with the selected outcome and duration when sales_rep submits the form', async () => {
    renderDetail('sales_rep');
    const durationInput = await screen.findByLabelText('משך (דק׳)');
    fireEvent.change(durationInput, { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('תוצאה'), { target: { value: 'no_answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'שמירת שיחה' }));
    await waitFor(() => {
      expect(postAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'log_phone_call',
          leadId: 'lead-1',
          callOutcome: 'no_answer',
          callDurationMinutes: 12,
        }),
      );
    });
  });

  it('schedules a CRM-only meeting from the PRD pipeline card', async () => {
    renderDetail('sales_rep');
    expect(await screen.findByText('תיאום פגישה')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('סוג'), { target: { value: 'zoom' } });
    fireEvent.change(screen.getByLabelText('מועד'), { target: { value: '2026-06-09T10:30' } });
    fireEvent.change(screen.getByLabelText('משך בדקות'), { target: { value: '45' } });
    fireEvent.change(screen.getByPlaceholderText('Zoom / Calendly / כתובת'), { target: { value: 'https://example.com/zoom' } });
    fireEvent.change(screen.getByPlaceholderText('סיכום קצר או מטרת הפגישה...'), { target: { value: 'שיחת התאמה ראשונה' } });
    fireEvent.click(screen.getByRole('button', { name: 'שמירת פגישה' }));

    await waitFor(() => {
      expect(postAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'schedule_meeting',
          leadId: 'lead-1',
          meetingType: 'zoom',
          meetingStartsAt: expect.any(String),
          meetingEndsAt: expect.any(String),
          meetingSummary: 'שיחת התאמה ראשונה',
          meetingUrl: 'https://example.com/zoom',
          dealId: null,
        }),
      );
    });
  });

  it('updates a scheduled meeting status from the PRD pipeline card', async () => {
    renderDetail('sales_rep');
    expect(await screen.findByText('פגישות')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'לא הגיע' }));

    await waitFor(() => {
      expect(postAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'update_meeting_status',
          leadId: 'lead-1',
          meetingId: 'meeting-1',
          meetingStatus: 'no_show',
          note: 'הלקוח לא הגיע לפגישה',
        }),
      );
    });
  });

  it('hides the phone-call form for the viewer role', async () => {
    renderDetail('viewer');
    await screen.findByRole('heading', { name: 'דנה כהן' });
    expect(screen.queryByText('תיעוד שיחת טלפון')).not.toBeInTheDocument();
  });

  it('renders an error message when the detail query fails', async () => {
    vi.mocked(fetchLeadDetail).mockRejectedValue(new Error('lookup failed'));
    renderDetail();
    expect(await screen.findByText(/שגיאה: lookup failed/)).toBeInTheDocument();
  });
});
