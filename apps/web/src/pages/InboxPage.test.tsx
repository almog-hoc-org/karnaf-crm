import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InboxPage } from './InboxPage';

vi.mock('@/lib/api', () => ({
  fetchAttentionInbox: vi.fn(async () => []),
  postQueueResolve: vi.fn(),
}));

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
  it('shows first-day operating guidance for employees', async () => {
    renderInbox();

    expect(screen.getByRole('heading', { name: 'לטיפול עכשיו' })).toBeInTheDocument();
    expect(screen.getByText('הדרך הקצרה לעבודה נכונה')).toBeInTheDocument();
    expect(screen.getByText('פותחים כרטיס, מטפלים, וסוגרים — בלי לחפש ידנית.')).toBeInTheDocument();
    expect(screen.getByText('לטפל לפי דחיפות')).toBeInTheDocument();
    expect(screen.getByText('פותחים את הליד')).toBeInTheDocument();
    expect(screen.getByText('סוגרים משימה')).toBeInTheDocument();
  });

  it('opens the lane requested in the URL', () => {
    renderInbox('/inbox?lane=risk');
    expect(screen.getByRole('button', { name: /בעיה\/סיכון/ })).toHaveAttribute('aria-pressed', 'true');
  });
});
