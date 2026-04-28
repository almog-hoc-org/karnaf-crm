import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DashboardSummary, QueueRow } from '@/lib/types';
import { DashboardPage } from './DashboardPage';

vi.mock('@/lib/api', () => ({
  fetchDashboardSummary: vi.fn(),
  fetchQueueList: vi.fn(),
}));

import { fetchDashboardSummary, fetchQueueList } from '@/lib/api';

const summaryFixture: DashboardSummary = {
  leadsToday: 12,
  unansweredNow: 3,
  hotLeadsNow: 5,
  paymentPendingNow: 2,
  slaRiskCount: 1,
  funnel: {
    new_count: 10,
    first_contact_count: 8,
    responded_count: 6,
    qualified_count: 4,
    checkout_count: 3,
    payment_pending_count: 2,
    won_count: 1,
    lost_count: 0,
    dormant_count: 0,
  },
  queueCounts: { hot_lead: 4, sla_risk: 1, payment_pending: 2 },
};

const queueFixture: QueueRow[] = [
  {
    id: 'q1',
    lead_id: 'lead-1',
    queue_type: 'hot_lead',
    priority_level: 1,
    status: 'pending',
    reason: 'high score',
    queue_summary: null,
    due_at: null,
    created_at: '2026-04-28T08:00:00Z',
    resolution_note: null,
    leads: { id: 'lead-1', full_name: 'דנה כהן', phone: '+972500000001', lead_status: 'qualified', lead_heat: 'hot', ownership_mode: 'ai_active' },
  },
  {
    id: 'q2',
    lead_id: 'lead-2',
    queue_type: 'payment_pending',
    priority_level: 2,
    status: 'pending',
    reason: null,
    queue_summary: null,
    due_at: null,
    created_at: '2026-04-28T07:00:00Z',
    resolution_note: null,
    leads: { id: 'lead-2', full_name: 'יוסי לוי', phone: '+972500000002', lead_status: 'payment_pending', lead_heat: 'warm', ownership_mode: 'ai_active' },
  },
];

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderDashboard() {
  return render(
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/leads/:leadId" element={<div>lead detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(fetchDashboardSummary).mockResolvedValue(summaryFixture);
  vi.mocked(fetchQueueList).mockResolvedValue(queueFixture);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('DashboardPage', () => {
  it('shows the loading indicator while the summary is being fetched', () => {
    vi.mocked(fetchDashboardSummary).mockImplementation(() => new Promise(() => {}));
    renderDashboard();
    expect(screen.getByText('טוען נתוני מצב...')).toBeInTheDocument();
  });

  it('renders KPI cards with values from the summary', async () => {
    renderDashboard();
    const heading = await screen.findByText('מסך מצב');
    const kpiSection = heading.parentElement!.nextElementSibling as HTMLElement;
    const kpiPairs: Array<[string, string]> = [
      ['לידים היום', '12'],
      ['ממתינים למענה', '3'],
      ['לידים חמים', '5'],
      ['ממתינים לתשלום', '2'],
      ['סיכון SLA', '1'],
    ];
    for (const [label, value] of kpiPairs) {
      const labelNode = within(kpiSection).getByText(label);
      const card = labelNode.parentElement!;
      expect(card.textContent).toContain(value);
    }
  });

  it('renders the funnel rows with the Hebrew labels', async () => {
    renderDashboard();
    await screen.findByText('מסך מצב');
    expect(screen.getByText('משפך המרה')).toBeInTheDocument();
    expect(screen.getByText('חדשים')).toBeInTheDocument();
    expect(screen.getByText('נשלחה הודעה')).toBeInTheDocument();
    expect(screen.getByText('הגיב')).toBeInTheDocument();
    expect(screen.getByText('הוסמך')).toBeInTheDocument();
    expect(screen.getByText('קישור רכישה')).toBeInTheDocument();
    expect(screen.getByText('נסגר ברכישה')).toBeInTheDocument();
  });

  it('renders the pending queue list with deep links to lead detail', async () => {
    renderDashboard();
    const link = await screen.findByRole('link', { name: /דנה כהן/ });
    expect(link).toHaveAttribute('href', '/leads/lead-1');
    expect(screen.getByRole('link', { name: /יוסי לוי/ })).toHaveAttribute('href', '/leads/lead-2');
    expect(screen.getByText('עדיפות 1')).toBeInTheDocument();
  });

  it('renders the empty state for the pending queue when there are no items', async () => {
    vi.mocked(fetchQueueList).mockResolvedValue([]);
    renderDashboard();
    await screen.findByText('מסך מצב');
    await waitFor(() => expect(screen.getByText('אין פריטים פתוחים.')).toBeInTheDocument());
  });

  it('renders an error message when the summary query fails', async () => {
    vi.mocked(fetchDashboardSummary).mockRejectedValue(new Error('boom'));
    renderDashboard();
    expect(await screen.findByText(/שגיאה: boom/)).toBeInTheDocument();
  });
});
