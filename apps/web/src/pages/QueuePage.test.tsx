import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { QueueRow } from '@/lib/types';
import { QueuePage } from './QueuePage';

vi.mock('@/lib/api', () => ({
  fetchQueueList: vi.fn(),
  postQueueResolve: vi.fn(),
}));

import { fetchQueueList, postQueueResolve } from '@/lib/api';

function makeRow(over: Partial<QueueRow> = {}): QueueRow {
  return {
    id: 'q-1',
    lead_id: 'lead-1',
    queue_type: 'first_response_due',
    priority_level: 30,
    status: 'pending',
    reason: 'New lead awaiting response',
    queue_summary: null,
    due_at: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    resolution_note: null,
    leads: {
      id: 'lead-1', full_name: 'Israel Israeli', phone: '0501234567',
      lead_status: 'new', lead_heat: 'warm', ownership_mode: 'ai_active',
    },
    ...over,
  };
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function renderQueue(initial = '/queue') {
  return render(
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter initialEntries={[initial]}>
        <QueuePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(fetchQueueList).mockResolvedValue([
    makeRow(),
    makeRow({ id: 'q-2', queue_type: 'sla_risk', priority_level: 80, leads: { ...makeRow().leads!, full_name: 'Dana Cohen' } }),
  ]);
  vi.mocked(postQueueResolve).mockResolvedValue({ ok: true });
});

afterEach(() => vi.clearAllMocks());

describe('QueuePage', () => {
  it('shows loading then renders rows with the lead deep link', async () => {
    renderQueue();
    expect(screen.getByText(/טוען/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Israel Israeli')).toBeInTheDocument());
    expect(screen.getByText('Dana Cohen')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Israel Israeli' });
    expect(link.getAttribute('href')).toBe('/leads/lead-1');
  });

  it('switches between status tabs and refetches', async () => {
    renderQueue();
    await waitFor(() => expect(screen.getByText('Israel Israeli')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'סגורים' }));
    await waitFor(() =>
      expect(vi.mocked(fetchQueueList)).toHaveBeenLastCalledWith({ queueType: undefined, status: 'resolved' }),
    );
  });

  it('filters by queue type when the dropdown changes', async () => {
    renderQueue();
    await waitFor(() => expect(screen.getByText('Israel Israeli')).toBeInTheDocument());

    const combo = screen.getByRole('combobox');
    fireEvent.change(combo, { target: { value: 'sla_risk' } });
    await waitFor(() =>
      expect(vi.mocked(fetchQueueList)).toHaveBeenLastCalledWith({ queueType: 'sla_risk', status: 'pending' }),
    );
  });

  it('hydrates state from URL search params', async () => {
    renderQueue('/queue?type=hot_lead&status=resolved');
    await waitFor(() =>
      expect(vi.mocked(fetchQueueList)).toHaveBeenCalledWith({ queueType: 'hot_lead', status: 'resolved' }),
    );
  });

  it('resolves a pending item via the close button after confirmation', async () => {
    renderQueue();
    await waitFor(() => expect(screen.getByText('Israel Israeli')).toBeInTheDocument());

    const rowButtons = screen.getAllByRole('button', { name: 'סגירה' });
    fireEvent.click(rowButtons[0]!);

    // Dialog opens; the confirm button is the second one named "סגירה".
    const dialog = await screen.findByRole('alertdialog');
    const confirm = await waitFor(() =>
      screen.getAllByRole('button', { name: 'סגירה' }).find((el) => dialog.contains(el))!,
    );
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(vi.mocked(postQueueResolve)).toHaveBeenCalledWith({ queueItemId: 'q-1', resolutionNote: null }),
    );
  });

  it('renders an empty state when there are no items', async () => {
    vi.mocked(fetchQueueList).mockResolvedValueOnce([]);
    renderQueue();
    await waitFor(() => expect(screen.getByText(/אין פריטים/)).toBeInTheDocument());
  });

  it('hides the close button on resolved tab and shows resolution_note', async () => {
    vi.mocked(fetchQueueList).mockResolvedValueOnce([
      makeRow({ status: 'resolved', resolution_note: 'sales reached out' }),
    ]);
    renderQueue('/queue?status=resolved');
    await waitFor(() => expect(screen.getByText('sales reached out')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'סגירה' })).not.toBeInTheDocument();
  });
});
