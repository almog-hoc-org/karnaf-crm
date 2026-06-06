import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnalyticsPage } from './AnalyticsPage';

vi.mock('@/lib/api', () => ({
  fetchAnalyticsSummary: vi.fn(),
}));

import { fetchAnalyticsSummary } from '@/lib/api';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function renderAnalytics() {
  return render(
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter>
        <AnalyticsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const SAMPLE = {
  ok: true as const,
  sourcePerformance: [
    {
      source: 'webinar',
      leads_total: 10, leads_engaged: 8, leads_qualified: 6,
      leads_checkout_pushed: 5, leads_won: 3, leads_lost: 1, win_rate_pct: 30,
    },
    {
      source: 'whatsapp_direct',
      leads_total: 4, leads_engaged: 4, leads_qualified: 2,
      leads_checkout_pushed: 2, leads_won: 1, leads_lost: 0, win_rate_pct: 25,
    },
  ],
  aging: {
    qualified: { count: 3, avgMinutes: 90, maxMinutes: 240 },
    nurture: { count: 1, avgMinutes: 5760, maxMinutes: 5760 },
  },
  recentActivity: [
    {
      id: 'evt-1', lead_id: 'lead-1', event_type: 'inbound_message_received',
      actor_type: 'provider', created_at: new Date().toISOString(),
      full_name: 'Israel Israeli', phone: '0501234567', lead_status: 'responded', lead_heat: 'warm',
    },
  ],
  aiVsHuman: [
    { touch_pattern: 'ai_only', lead_status: 'won', leads_count: 5 },
    { touch_pattern: 'human_last', lead_status: 'lost', leads_count: 2 },
  ],
  promptVariants: [
    {
      prompt_version: 'v1', playbook_name: 'qualification',
      decisions_total: 100, success_total: 95, blocked_total: 5,
      leads_touched: 40, leads_won: 12, leads_lost: 8,
    },
  ],
  cohorts: [
    {
      cohort_week: '2026-04-13', source: 'webinar',
      leads_total: 12, responded: 10, qualified: 7, checkout_pushed: 5,
      won: 3, lost: 1, win_rate_pct: 25, avg_minutes_to_win: 4320,
    },
  ],
  firstResponseTimes: [
    { source: 'webinar', measured_leads: 8, p50_minutes: 30, p90_minutes: 240, max_minutes: 600, unanswered_leads: 1 },
    { source: 'whatsapp_direct', measured_leads: 4, p50_minutes: 5, p90_minutes: 20, max_minutes: 60, unanswered_leads: 0 },
  ],
};

beforeEach(() => {
  vi.mocked(fetchAnalyticsSummary).mockResolvedValue(SAMPLE);
});

afterEach(() => vi.clearAllMocks());

describe('AnalyticsPage', () => {
  it('shows loading state, then a row per source', async () => {
    renderAnalytics();
    expect(screen.getByText((content) => content.includes('טוען... נתונים...'))).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('מה כדאי לעשות לפי הנתונים?')).toBeInTheDocument());
    expect(screen.getAllByText('webinar').length).toBeGreaterThan(0);
    expect(screen.getAllByText('whatsapp_direct').length).toBeGreaterThan(0);
    // win_rate_pct rendered with the % suffix in the bar — appears multiple
    // times in the page (source perf, prompt variant outcomes), so just
    // confirm at least one occurrence exists.
    expect(screen.getAllByText('30%').length).toBeGreaterThan(0);
  });

  it('renders manager action insights', async () => {
    renderAnalytics();
    await waitFor(() => expect(screen.getByText('להגדיל את webinar')).toBeInTheDocument());
    expect(screen.getByText('לקצר מענה ב-webinar')).toBeInTheDocument();
    expect(screen.getByText('המרה כוללת')).toBeInTheDocument();
  });

  it('renders aging buckets per status', async () => {
    renderAnalytics();
    await waitFor(() => expect(screen.getByText(/3 לידים/)).toBeInTheDocument());
    expect(screen.getByText(/1 לידים/)).toBeInTheDocument();
  });

  it('renders the AI vs human outcomes table', async () => {
    renderAnalytics();
    await waitFor(() => expect(screen.getByText('ai_only')).toBeInTheDocument());
    expect(screen.getByText('human_last')).toBeInTheDocument();
    // The leads_count cell sits inside the same row as the touch_pattern label.
    const aiOnlyRow = screen.getByText('ai_only').closest('tr')!;
    expect(aiOnlyRow.textContent).toContain('5');
  });

  it('renders prompt-variant outcomes with version code', async () => {
    renderAnalytics();
    await waitFor(() => expect(screen.getByText('qualification')).toBeInTheDocument());
    expect(screen.getByText('v1')).toBeInTheDocument();
  });

  it('renders recent activity entries linked to the lead', async () => {
    renderAnalytics();
    await waitFor(() => expect(screen.getByText('inbound_message_received')).toBeInTheDocument());
    const link = screen.getByRole('link', { name: /inbound_message_received/ });
    expect(link.getAttribute('href')).toBe('/leads/lead-1');
  });

  it('renders the first-response section with one row per source', async () => {
    renderAnalytics();
    await waitFor(() => expect(screen.getByText(/זמן מענה ראשון/)).toBeInTheDocument());
    // Both sources appear in the FRT table; webinar also appears in source perf.
    expect(screen.getAllByText('webinar').length).toBeGreaterThanOrEqual(2);
    // The webinar FRT row carries unanswered=1; assert the row text contains it.
    const frtSection = screen.getByText(/זמן מענה ראשון/).closest('section')!;
    const webinarRow = Array.from(frtSection.querySelectorAll('tr'))
      .find((tr) => tr.textContent?.startsWith('webinar'));
    expect(webinarRow).toBeTruthy();
    expect(webinarRow!.textContent).toContain('1');
  });

  it('renders the cohorts section with the formatted week', async () => {
    renderAnalytics();
    await waitFor(() => expect(screen.getByText(/קבוצות לפי שבוע/)).toBeInTheDocument());
    // 2026-04-13 → 13/04/26
    expect(screen.getByText('13/04/26')).toBeInTheDocument();
  });

  it('shows an error message when the analytics query fails', async () => {
    vi.mocked(fetchAnalyticsSummary).mockRejectedValueOnce(new Error('boom'));
    renderAnalytics();
    await waitFor(() => expect(screen.getByText(/שגיאה: boom/)).toBeInTheDocument());
  });
});
