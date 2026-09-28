import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GlobalSearch } from './GlobalSearch';

vi.mock('@/lib/api', () => ({
  fetchLeadsList: vi.fn(async () => ({
    leads: [
      { id: 'lead-1', full_name: 'דנה כהן', phone: '0501234567', email: 'dana@example.com', updated_at: new Date().toISOString() },
      { id: 'lead-2', full_name: 'דני לוי', phone: '0507654321', email: null, updated_at: new Date().toISOString() },
    ],
    total: 2, limit: 8, offset: 0,
  })),
}));

import { fetchLeadsList } from '@/lib/api';

function renderSearch() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/inbox']}>
        <Routes>
          <Route path="/inbox" element={<GlobalSearch />} />
          <Route path="/leads/:id" element={<div>lead page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('GlobalSearch', () => {
  it('opens on Ctrl+K and jumps to the first hit on Enter', async () => {
    renderSearch();
    fireEvent.keyDown(window, { code: 'KeyK', ctrlKey: true });

    const input = await screen.findByLabelText('חיפוש לפי שם, טלפון או מייל');
    fireEvent.change(input, { target: { value: 'דנ' } });

    expect(await screen.findByText('דנה כהן')).toBeInTheDocument();
    expect(fetchLeadsList).toHaveBeenCalledWith({ search: 'דנ', limit: 8 });

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('lead page')).toBeInTheDocument());
  });

  it('waits for two characters before searching', async () => {
    vi.mocked(fetchLeadsList).mockClear();
    renderSearch();
    fireEvent.click(screen.getByRole('button', { name: 'חיפוש לקוח' }));
    fireEvent.change(await screen.findByLabelText('חיפוש לפי שם, טלפון או מייל'), { target: { value: 'ד' } });

    expect(screen.getByText('הקלידו לפחות שני תווים.')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 300));
    expect(fetchLeadsList).not.toHaveBeenCalled();
  });
});
