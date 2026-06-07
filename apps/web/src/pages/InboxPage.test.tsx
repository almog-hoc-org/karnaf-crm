import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fetchAttentionInbox } from '@/lib/api';
import { InboxPage } from './InboxPage';

vi.mock('@/lib/api', () => ({
  fetchAttentionInbox: vi.fn(async () => []),
  postQueueResolve: vi.fn(),
}));

const mockedFetchAttentionInbox = vi.mocked(fetchAttentionInbox);

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
    mockedFetchAttentionInbox.mockResolvedValue([]);
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
        priority_level: 1,
        reason: 'ביקשה שיחת ייעוץ עם נציג',
        due_at: '2026-06-07T08:00:00.000Z',
        created_at: '2026-06-07T08:00:00.000Z',
      },
    ]);

    renderInbox();

    expect(await screen.findByText('דנה כהן')).toBeInTheDocument();
    expect(screen.getByText('ליווי משקיעים')).toBeInTheDocument();
    expect(screen.getAllByText('להתקשר ולסגור אבחון קצר').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/מטרת השיחה היא להבין התאמה/).length).toBeGreaterThan(0);
  });
});
