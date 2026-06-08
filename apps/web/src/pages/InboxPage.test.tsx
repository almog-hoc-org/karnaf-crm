import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fetchAttentionInbox, postAdminAction } from '@/lib/api';
import { InboxPage } from './InboxPage';

vi.mock('@/lib/api', () => ({
  fetchAttentionInbox: vi.fn(async () => []),
  postAdminAction: vi.fn(async () => ({ ok: true, action: 'log_phone_call' })),
  postQueueResolve: vi.fn(),
}));

const mockedFetchAttentionInbox = vi.mocked(fetchAttentionInbox);
const mockedPostAdminAction = vi.mocked(postAdminAction);

function renderInbox(initialEntry = '/inbox') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <InboxPage />
      </MemoryRouter>
    </QueryClientProvider>,
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

  it('shows first-day operating guidance for employees', async () => {
    renderInbox();

    expect(screen.getByRole('heading', { name: 'היום שלי' })).toBeInTheDocument();
    expect(screen.getByText('הדבר הראשון לפתוח')).toBeInTheDocument();
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
    expect(screen.getByText('לפתוח ראשון: דנה כהן')).toBeInTheDocument();
    expect(screen.getByText('ליווי משקיעים')).toBeInTheDocument();
    expect(screen.getByText('ליד חם')).toBeInTheDocument();
    expect(screen.getByText('מכירה חמה')).toBeInTheDocument();
    expect(screen.getByText('צריך שיחה')).toBeInTheDocument();
    expect(screen.getByText('שיחת מכירה')).toBeInTheDocument();
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

    expect(await screen.findByText('WhatsApp פתוח למענה חופשי')).toBeInTheDocument();
    expect(screen.getByText(/אפשר לענות חופשי מתוך הכרטיס/)).toBeInTheDocument();
    expect(screen.getByText('WhatsApp מחוץ לחלון 24 שעות')).toBeInTheDocument();
    expect(screen.getByText(/ההודעה תישמר ותישלח רק כשהלקוח יענה שוב/)).toBeInTheDocument();
    expect(screen.getByText('WhatsApp פתוח')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp מחוץ ל-24ש׳')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'פתיחת WhatsApp עבור רוני לוי' })).toHaveAttribute('href', 'https://wa.me/972500000001');
    expect(screen.getByRole('link', { name: 'פתיחת WhatsApp עבור איתי כהן' })).toHaveAttribute('href', 'https://wa.me/972500000002');
  });
});
