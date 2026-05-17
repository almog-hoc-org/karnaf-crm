import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext, type AuthState, type Role } from '@/auth/auth-context';
import type { ConversationRow, LeadDetail, MessageRow, QueueRow, TaskRow, EventRow } from '@/lib/types';
import { LeadDetailPage } from './LeadDetailPage';

vi.mock('@/lib/api', () => ({
  fetchLeadDetail: vi.fn(),
  postAdminAction: vi.fn(),
  postSendReply: vi.fn(),
  postQueueResolve: vi.fn(),
}));

import {
  fetchLeadDetail, postAdminAction, postSendReply, postQueueResolve,
} from '@/lib/api';

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
    id: 'm1', lead_id: 'lead-1', conversation_id: 'conv-1', provider_message_id: null,
    sender_type: 'lead', sender_name: 'דנה', direction: 'inbound', message_type: 'text',
    content_text: 'שלום, אשמח לפרטים', provider_status: null, provider_error: null,
    delivered_at: null, read_at: null, created_at: '2026-04-28T09:30:00Z',
  },
  {
    id: 'm2', lead_id: 'lead-1', conversation_id: 'conv-1', provider_message_id: 'wa-1',
    sender_type: 'ai', sender_name: 'AI', direction: 'outbound', message_type: 'text',
    content_text: 'היי דנה, נשמח לעזור.', provider_status: 'delivered', provider_error: null,
    delivered_at: '2026-04-28T09:31:00Z', read_at: null, created_at: '2026-04-28T09:31:00Z',
  },
];

const queueItems: QueueRow[] = [
  {
    id: 'q1', lead_id: 'lead-1', queue_type: 'hot_lead', priority_level: 90,
    status: 'pending', reason: 'high score', queue_summary: null, due_at: null,
    created_at: '2026-04-28T09:00:00Z', resolution_note: null,
  },
];

const tasks: TaskRow[] = [
  { id: 't1', lead_id: 'lead-1', task_type: 'follow_up', task_status: 'open', owner_type: 'mia', title: 'מעקב', description: null, priority_level: 50, due_at: null, created_at: '2026-04-28T09:00:00Z' },
];

const events: EventRow[] = [
  { id: 'e1', lead_id: 'lead-1', conversation_id: 'conv-1', event_type: 'lead_created', actor_type: 'system', event_payload: {}, created_at: '2026-04-27T08:00:00Z' },
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
    ok: true, lead, conversations: [conversation], messages, queueItems, tasks, events,
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
    expect(screen.getByText('היי דנה, נשמח לעזור.')).toBeInTheDocument();
    expect(screen.getByText('שלום, אשמח לפרטים')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← חזרה לרשימה' })).toHaveAttribute('href', '/leads');
  });

  it('invokes mark_won after confirming the action dialog', async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'סימון כסגירה' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'אישור' }));
    await waitFor(() => {
      expect(postAdminAction).toHaveBeenCalledWith(expect.objectContaining({
        action: 'mark_won', leadId: 'lead-1',
      }));
    });
  });

  it('invokes mark_lost with manual_close note after confirming dialog', async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'סימון כאבוד' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'אישור' }));
    await waitFor(() => {
      expect(postAdminAction).toHaveBeenCalledWith(expect.objectContaining({
        action: 'mark_lost', leadId: 'lead-1', note: 'manual_close',
      }));
    });
  });

  it('cancel button on the confirm dialog does not fire the action', async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'DNC' }));
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
        leadId: 'lead-1', conversationId: 'conv-1', text: 'שלום, מתי נוח לך?',
      });
    });
    expect(textarea).toHaveValue('');
  });

  it('disables the reply box when the lead is marked do_not_contact', async () => {
    vi.mocked(fetchLeadDetail).mockResolvedValue({
      ok: true,
      lead: { ...lead, do_not_contact: true },
      conversations: [conversation], messages, queueItems, tasks, events,
      humanOwnerProfile: null,
    });
    renderDetail();
    const textarea = await screen.findByPlaceholderText('לא ניתן לשלוח (ליד מושתק או חסרה שיחה).');
    expect(textarea).toBeDisabled();
    expect(screen.getByRole('button', { name: 'שליחה' })).toBeDisabled();
  });

  it('resolves a pending queue item via the close confirmation dialog', async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'סגירה' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = await waitFor(() =>
      screen.getAllByRole('button', { name: 'סגירה' }).find((el) => dialog.contains(el))!,
    );
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(postQueueResolve).toHaveBeenCalledWith({
        queueItemId: 'q1', resolutionNote: null,
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
      expect(postAdminAction).toHaveBeenCalledWith(expect.objectContaining({
        action: 'log_phone_call',
        leadId: 'lead-1',
        callOutcome: 'no_answer',
        callDurationMinutes: 12,
      }));
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
