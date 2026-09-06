import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext, type AuthState, type Role } from '@/auth/auth-context';
import { fetchAttentionInbox, postAdminAction, postSendReply } from '@/lib/api';
import { InboxPage } from './InboxPage';

vi.mock('@/lib/api', () => ({
  fetchAttentionInbox: vi.fn(async () => []),
  postAdminAction: vi.fn(async () => ({ ok: true, action: 'log_phone_call' })),
  postQueueResolve: vi.fn(),
  postSendReply: vi.fn(async () => ({ ok: true, mode: 'sent' })),
  fetchMessageTemplates: vi.fn(async () => ({ templates: [] })),
}));

const mockedFetchAttentionInbox = vi.mocked(fetchAttentionInbox);
const mockedPostAdminAction = vi.mocked(postAdminAction);
const mockedPostSendReply = vi.mocked(postSendReply);

function makeAuth(role: Role | null): AuthState {
  return {
    session: null, user: null, role, loading: false,
    signIn: async () => ({ error: null }),
    signInWithGoogle: async () => ({ error: null }),
    signUp: async () => ({ error: null, needsEmailConfirmation: true }),
    signOut: async () => {},
  } as AuthState;
}

function renderInbox(initialEntry = '/inbox', role: Role | null = 'admin') {
  return render(
    <AuthContext.Provider value={makeAuth(role)}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <InboxPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe('InboxPage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-06-07T10:00:00.000Z'));
    mockedFetchAttentionInbox.mockResolvedValue([]);
    mockedPostAdminAction.mockResolvedValue({ ok: true, action: 'log_phone_call' });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A failed fetch and an empty inbox produced the same "🎉 אין כרגע טיפול
  // פתוח" screen, which tells the operator to stop working while leads are
  // waiting. The two must never render the same way again.
  it('shows a load failure as a failure, not as an empty inbox', async () => {
    mockedFetchAttentionInbox.mockRejectedValue(new Error('boom 500'));
    renderInbox();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('לא הצלחנו לטעון את הנתונים');
    // The distinction the operator actually needs, and the error itself.
    expect(alert).toHaveTextContent('לא אומר שאין עבודה');
    expect(alert).toHaveTextContent('boom 500');
    expect(screen.getByRole('button', { name: 'נסה שוב' })).toBeInTheDocument();
    expect(screen.queryByText('אין כרגע טיפול פתוח בקטגוריה הזו')).not.toBeInTheDocument();
  });

  it('still shows the celebratory empty state when the inbox is genuinely clear', async () => {
    mockedFetchAttentionInbox.mockResolvedValue([]);
    renderInbox();

    expect(await screen.findByText('אין כרגע טיפול פתוח בקטגוריה הזו')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows first-day operating guidance for employees', async () => {
    renderInbox();

    expect(screen.getByRole('heading', { name: 'היום שלי' })).toBeInTheDocument();
    expect(screen.getByText('הדרך הקצרה לעבודה נכונה')).toBeInTheDocument();
    expect(screen.getByText('פותחים כרטיס, מטפלים, וסוגרים — בלי לחפש ידנית.')).toBeInTheDocument();
    expect(screen.getByText('לטפל לפי דחיפות')).toBeInTheDocument();
    expect(screen.getByText('פותחים את הליד')).toBeInTheDocument();
    expect(screen.getByText('סוגרים נכון')).toBeInTheDocument();
    expect(screen.getByText(/הוחזר ל-AI/)).toBeInTheDocument();
  });

  it('opens the lane requested in the URL', () => {
    renderInbox('/inbox?lane=risk');
    expect(screen.getByRole('button', { name: /בעיה\/סיכון/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows a simple next action and product context for a rep', async () => {
    mockedFetchAttentionInbox.mockResolvedValue([
      {
        kind: 'queue',
        ref_id: 'queue-1',
        lead_id: '11111111-1111-1111-1111-111111111111',
        lead_name: 'דנה כהן',
        lead_phone: '0501234567',
        lead_status: 'responded',
        lead_heat: 'hot',
        ownership_mode: 'phone_sales_pending',
        product_interest: 'investor_mentorship',
        suggested_next_action: null,
        intake_segment: 'hot_sales',
        queue_type: 'sales_call',
        queue_summary: 'ביקשה לדבר עם נציג על התאמת ליווי משקיעים',
        priority_level: 1,
        reason: 'ביקשה שיחת ייעוץ עם נציג',
        last_inbound_at: '2026-06-07T08:00:00.000Z',
        last_outbound_at: null,
        due_at: '2026-06-07T08:00:00.000Z',
        created_at: '2026-06-07T08:00:00.000Z',
      },
    ]);

    renderInbox();

    expect(await screen.findByText('דנה כהן')).toBeInTheDocument();
    expect(screen.getByText('ליווי משקיעים')).toBeInTheDocument();
    expect(screen.getByText('ליד חם')).toBeInTheDocument();
    expect(screen.getByText('שיחת מכירה')).toBeInTheDocument();
    // heat=hot and intake_segment=hot_sales are the same fact; the card
    // says it once.
    expect(screen.queryByText('מכירה חמה')).not.toBeInTheDocument();
    // The lane is stated once, by the action pill — the old "צריך שיחה"
    // chip repeated it a few pixels lower on the same card.
    expect(screen.getAllByText('להתקשר').length).toBeGreaterThan(0);
    expect(screen.queryByText('צריך שיחה')).not.toBeInTheDocument();
    expect(screen.getByText('ביקשה לדבר עם נציג על התאמת ליווי משקיעים')).toBeInTheDocument();
    expect(screen.getByText('מה להגיד עכשיו')).toBeInTheDocument();
    expect(screen.getByText(/דנה, ראיתי שפנית לגבי ליווי משקיעים/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'העתקת נוסח' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('דנה, ראיתי שפנית לגבי ליווי משקיעים'));
    expect(await screen.findByRole('button', { name: 'הועתק' })).toBeInTheDocument();
    expect(screen.getAllByText('להתקשר ולסגור אבחון קצר').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/מטרת השיחה היא להבין התאמה/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'חיוג אל דנה כהן' })).toHaveAttribute('href', 'tel:0501234567');

    fireEvent.click(screen.getByRole('button', { name: 'סימון אין מענה' }));
    expect(screen.getByText('לרשום ניסיון שיחה ללא מענה עבור דנה כהן?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'רישום אין מענה' }));
    await waitFor(() => expect(mockedPostAdminAction).toHaveBeenCalledWith({
      action: 'log_phone_call',
      leadId: '11111111-1111-1111-1111-111111111111',
      callOutcome: 'no_answer',
      callDurationMinutes: 0,
      note: 'סומן אין מענה מתוך היום שלי',
    }));
  });

  it('explains whether WhatsApp can be answered freely from the daily inbox', async () => {
    mockedFetchAttentionInbox.mockResolvedValue([
      {
        kind: 'mia_reply',
        ref_id: 'open-window',
        lead_id: '22222222-2222-2222-2222-222222222222',
        lead_name: 'רוני לוי',
        lead_phone: '0500000001',
        lead_status: 'human_handoff',
        lead_heat: 'warm',
        ownership_mode: 'mia_active',
        product_interest: 'digital_program',
        suggested_next_action: null,
        intake_segment: 'needs_human',
        queue_type: null,
        queue_summary: null,
        last_inbound_at: '2026-06-07T09:30:00.000Z',
        last_outbound_at: null,
        priority_level: 2,
        reason: 'הלקוח השיב — נדרשת תגובה ידנית',
        due_at: '2026-06-07T09:30:00.000Z',
        created_at: '2026-06-07T09:30:00.000Z',
      },
      {
        kind: 'queue',
        ref_id: 'closed-window',
        lead_id: '33333333-3333-3333-3333-333333333333',
        lead_name: 'איתי כהן',
        lead_phone: '0500000002',
        lead_status: 'human_handoff',
        lead_heat: 'warm',
        ownership_mode: 'mia_active',
        product_interest: 'investor_mentorship',
        suggested_next_action: null,
        intake_segment: 'needs_human',
        queue_type: 'pending_manual_reply',
        queue_summary: 'ממתין לשליחת הודעת נציג בוואטסאפ',
        last_inbound_at: '2026-06-05T09:30:00.000Z',
        last_outbound_at: null,
        priority_level: 2,
        reason: 'הודעה ידנית ממתינה',
        due_at: '2026-06-07T09:30:00.000Z',
        created_at: '2026-06-07T09:30:00.000Z',
      },
    ]);

    renderInbox('/inbox?lane=reply');

    // The window is reported once per card, by a chip. It used to also
    // get a full titled banner directly underneath the chip saying the
    // same thing at four times the size.
    expect(await screen.findByText('WhatsApp פתוח')).toBeInTheDocument();
    expect(screen.queryByText('WhatsApp פתוח למענה חופשי')).not.toBeInTheDocument();
    expect(screen.getByText('WhatsApp מחוץ ל-24ש׳')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'פתיחת WhatsApp עבור רוני לוי' })).toHaveAttribute('href', 'https://wa.me/972500000001');
    expect(screen.getByRole('link', { name: 'פתיחת WhatsApp עבור איתי כהן' })).toHaveAttribute('href', 'https://wa.me/972500000002');
  });

  function replyRow(over: Record<string, unknown> = {}) {
    return {
      kind: 'mia_reply',
      ref_id: 'reply-1',
      lead_id: '44444444-4444-4444-4444-444444444444',
      lead_name: 'נועה בר',
      lead_phone: '0500000003',
      lead_status: 'human_handoff',
      lead_heat: 'warm',
      ownership_mode: 'mia_active',
      product_interest: 'digital_program',
      suggested_next_action: null,
      intake_segment: 'needs_human',
      queue_type: null,
      queue_summary: null,
      last_inbound_at: '2026-06-07T09:30:00.000Z',
      last_outbound_at: null,
      priority_level: 1,
      reason: 'הלקוח כתב — ממתין לתשובה',
      due_at: '2026-06-07T09:30:00.000Z',
      created_at: '2026-06-07T09:30:00.000Z',
      last_inbound_text: 'מתי מתחיל הקורס?',
      last_inbound_conversation_id: 'conv-1',
      last_inbound_channel: 'whatsapp',
      ...over,
    } as never;
  }

  it('sends an inline reply from the card and removes it only on success', async () => {
    // Once: the safety-net refetch after the send must return the row as
    // answered (gone), like the real RPC would.
    mockedFetchAttentionInbox.mockResolvedValueOnce([replyRow()]);
    mockedPostSendReply.mockResolvedValue({ ok: true, mode: 'sent' });

    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'השב כאן 💬' }));
    const textarea = screen.getByPlaceholderText(/הקלד תשובה ידנית/);
    fireEvent.change(textarea, { target: { value: 'הקורס מתחיל בספטמבר' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(mockedPostSendReply).toHaveBeenCalledWith({
      leadId: '44444444-4444-4444-4444-444444444444',
      conversationId: 'conv-1',
      text: 'הקורס מתחיל בספטמבר',
    }));
    await waitFor(() => expect(screen.queryByText('נועה בר')).not.toBeInTheDocument());
  });

  it('keeps the card and the draft when the send fails', async () => {
    mockedFetchAttentionInbox.mockResolvedValue([replyRow()]);
    mockedPostSendReply.mockRejectedValue(new Error('נכשלה השליחה'));

    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'השב כאן 💬' }));
    const textarea = screen.getByPlaceholderText(/הקלד תשובה ידנית/);
    fireEvent.change(textarea, { target: { value: 'טיוטה חשובה' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(mockedPostSendReply).toHaveBeenCalled());
    expect(screen.getByText('נועה בר')).toBeInTheDocument();
    expect(screen.getByDisplayValue('טיוטה חשובה')).toBeInTheDocument();
  });

  it('offers no inline composer without a conversation id, keeping the wa.me link', async () => {
    mockedFetchAttentionInbox.mockResolvedValue([replyRow({ last_inbound_conversation_id: null })]);

    renderInbox();

    expect(await screen.findByText('נועה בר')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'השב כאן 💬' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'פתיחת WhatsApp עבור נועה בר' })).toBeInTheDocument();
  });

  it('quick-classifies heat from the card for editing roles only', async () => {
    mockedFetchAttentionInbox.mockResolvedValue([replyRow()]);
    mockedPostAdminAction.mockResolvedValue({ ok: true, action: 'update_lead_meta' });

    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'סיווג ⚡' }));
    fireEvent.click(screen.getByRole('button', { name: 'חם' }));

    await waitFor(() => expect(mockedPostAdminAction).toHaveBeenCalledWith({
      action: 'update_lead_meta',
      leadId: '44444444-4444-4444-4444-444444444444',
      metaUpdates: { lead_heat: 'hot' },
    }));
  });

  it('navigates cards with the keyboard and triages the focused card', async () => {
    mockedFetchAttentionInbox.mockResolvedValueOnce([replyRow()]);
    mockedPostAdminAction.mockResolvedValue({ ok: true, action: 'mark_reviewed' });

    renderInbox();
    expect(await screen.findByText('נועה בר')).toBeInTheDocument();

    // Physical-key codes: works the same on the Hebrew layout.
    fireEvent.keyDown(window, { code: 'KeyJ' });
    fireEvent.keyDown(window, { code: 'KeyD' });

    await waitFor(() => expect(mockedPostAdminAction).toHaveBeenCalledWith({
      action: 'mark_reviewed',
      leadId: '44444444-4444-4444-4444-444444444444',
      note: 'טופל מתוך היום שלי',
    }));
  });

  it('ignores triage keys while typing in the inline composer', async () => {
    mockedFetchAttentionInbox.mockResolvedValue([replyRow()]);

    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'השב כאן 💬' }));
    mockedPostAdminAction.mockClear();
    const textarea = screen.getByPlaceholderText(/הקלד תשובה ידנית/);
    fireEvent.keyDown(textarea, { code: 'KeyD' });

    expect(mockedPostAdminAction).not.toHaveBeenCalled();
  });

  it('hides quick-classify from roles without meta-edit permission', async () => {
    mockedFetchAttentionInbox.mockResolvedValue([replyRow()]);

    renderInbox('/inbox', 'sales_rep');

    expect(await screen.findByText('נועה בר')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'סיווג ⚡' })).not.toBeInTheDocument();
  });
});
