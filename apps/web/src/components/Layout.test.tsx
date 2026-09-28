import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext, type AuthState, type Role } from '@/auth/auth-context';
import { Layout } from './Layout';

vi.mock('@/lib/api', () => ({
  fetchAttentionInbox: vi.fn(async () => []),
}));

import { fetchAttentionInbox } from '@/lib/api';

interface RenderOpts {
  role?: Role | null;
  email?: string;
  signOut?: () => Promise<void>;
  initialPath?: string;
}

function makeAuth({ role = 'viewer', email = 'op@example.com', signOut = async () => {} }: RenderOpts): AuthState {
  const fakeUser = { id: 'u1', email } as unknown as AuthState['user'];
  const fakeSession = { user: fakeUser } as unknown as AuthState['session'];
  return {
    session: fakeSession,
    user: fakeUser,
    role,
    loading: false,
    signIn: async () => ({ error: null }),
    signInWithGoogle: async () => ({ error: null }),
    signUp: async () => ({ error: null, needsEmailConfirmation: true }),
    signOut,
    profileError: null,
    reloadProfile: async () => {},
  };
}

function renderLayout(opts: RenderOpts = {}) {
  const initialPath = opts.initialPath ?? '/leads';
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={makeAuth(opts)}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<div>dashboard outlet</div>} />
              <Route path="/leads" element={<div>leads outlet</div>} />
              <Route path="/users" element={<div>users outlet</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('Layout', () => {
  it('renders the operator nav (היום, לקוחות) and the outlet', () => {
    renderLayout({ role: 'viewer' });
    expect(screen.getByRole('link', { name: 'היום' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'לקוחות' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'דיוור' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'עוד' })).not.toBeInTheDocument();
    expect(screen.getByText('leads outlet')).toBeInTheDocument();
  });

  it.each(['owner', 'admin', 'mia'] as const)('shows the four-item nav to %s', (role) => {
    renderLayout({ role });
    for (const name of ['היום', 'לקוחות', 'דיוור', 'עוד']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
    // The retired items are gone: the dashboard is reached from the hub.
    expect(screen.queryByRole('link', { name: 'ניהול' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'דוחות' })).not.toBeInTheDocument();
  });

  it('hides manager links from sales representatives', () => {
    renderLayout({ role: 'sales_rep' });
    expect(screen.queryByRole('link', { name: 'דיוור' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'עוד' })).not.toBeInTheDocument();
  });

  it('renders the user email and the role in Hebrew', () => {
    renderLayout({ role: 'admin', email: 'admin@karnaf.io' });
    expect(screen.getByText('admin@karnaf.io')).toBeInTheDocument();
    expect(screen.getByText('מנהל/ת')).toBeInTheDocument();
    expect(screen.queryByText('admin')).not.toBeInTheDocument();
  });

  it('shows a red attention badge on the inbox link and prefixes the title', async () => {
    // 2 reply-lane rows + 1 snooze_due count; the queue row does not.
    vi.mocked(fetchAttentionInbox).mockResolvedValueOnce([
      { kind: 'mia_reply' },
      { kind: 'awaiting_reply' },
      { kind: 'snooze_due' },
      { kind: 'queue' },
    ] as never);
    renderLayout({ role: 'viewer' });
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(document.title).toBe('(3) Karnaf CRM');
  });

  it('invokes signOut when the exit button is pressed', () => {
    const signOut = vi.fn(async () => {});
    renderLayout({ role: 'viewer', signOut });
    fireEvent.click(screen.getByRole('button', { name: 'יציאה' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
