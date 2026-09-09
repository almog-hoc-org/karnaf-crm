import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext, type AuthState, type Role } from '@/auth/auth-context';
import type { ProfileRow } from '@/lib/api';
import { UsersPage } from './UsersPage';

vi.mock('@/lib/api', () => ({
  fetchUsersList: vi.fn(),
  postCreateUser: vi.fn(),
  postUpdateUser: vi.fn(),
}));

import { fetchUsersList, postCreateUser, postUpdateUser } from '@/lib/api';

function makeProfile(over: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: 'user-1',
    email: 'mia@karnaf.io',
    full_name: 'Mia Operator',
    role: 'mia',
    is_active: true,
    created_at: '2026-04-01T08:00:00Z',
    updated_at: '2026-04-20T08:00:00Z',
    ...over,
  };
}

function makeAuth(role: Role | null, userId = 'admin-1'): AuthState {
  const fakeUser = { id: userId, email: 'admin@karnaf.io' } as unknown as AuthState['user'];
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
    profileError: null,
    reloadProfile: async () => {},
  };
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function renderUsers(role: Role | null = 'admin', userId = 'admin-1') {
  return render(
    <QueryClientProvider client={makeClient()}>
      <AuthContext.Provider value={makeAuth(role, userId)}>
        <MemoryRouter initialEntries={['/users']}>
          <Routes>
            <Route path="/users" element={<UsersPage />} />
            <Route path="/" element={<div>home outlet</div>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(fetchUsersList).mockResolvedValue([
    makeProfile({ id: 'user-1', email: 'mia@karnaf.io', full_name: 'Mia Operator', role: 'mia' }),
    makeProfile({ id: 'admin-1', email: 'admin@karnaf.io', full_name: 'Admin', role: 'admin' }),
  ]);
  vi.mocked(postCreateUser).mockResolvedValue({ ok: true, profile: makeProfile() });
  vi.mocked(postUpdateUser).mockResolvedValue({ ok: true, profile: makeProfile() });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('UsersPage', () => {
  it('redirects non-admin roles back to /', () => {
    renderUsers('sales_rep');
    expect(screen.getByText('home outlet')).toBeInTheDocument();
    expect(screen.queryByText('ניהול משתמשים')).not.toBeInTheDocument();
  });

  it('redirects mia operators back to /', () => {
    renderUsers('mia');
    expect(screen.getByText('home outlet')).toBeInTheDocument();
  });

  it('renders the user list and the create form for admins', async () => {
    renderUsers('admin');
    expect(await screen.findByRole('heading', { name: 'ניהול משתמשים' })).toBeInTheDocument();
    expect(await screen.findByText('mia@karnaf.io', undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'הוספת משתמש' })).toBeInTheDocument();
  });

  it('submits the create form with the entered values', async () => {
    renderUsers('admin');
    await screen.findByRole('heading', { name: 'ניהול משתמשים' });
    const submitBtn = screen.getByRole('button', { name: 'הוספת משתמש' });
    const form = submitBtn.closest('form')!;
    const inputs = form.querySelectorAll('input');
    const emailInput = inputs[0]!;
    const passwordInput = inputs[1]!;
    const fullNameInput = inputs[2]!;
    const roleSelect = form.querySelector('select')!;
    fireEvent.change(emailInput, { target: { value: 'new@karnaf.io' } });
    fireEvent.change(passwordInput, { target: { value: 'verySecret123!' } });
    fireEvent.change(fullNameInput, { target: { value: 'משתמש חדש' } });
    fireEvent.change(roleSelect, { target: { value: 'sales_rep' } });
    fireEvent.submit(form);
    await waitFor(() => {
      const firstArg = vi.mocked(postCreateUser).mock.calls[0]?.[0];
      expect(firstArg).toEqual({
        email: 'new@karnaf.io',
        password: 'verySecret123!',
        role: 'sales_rep',
        fullName: 'משתמש חדש',
      });
    });
  });

  it('updates a user role via the role select', async () => {
    renderUsers('admin');
    await screen.findByText('mia@karnaf.io', undefined, { timeout: 4000 });
    const miaRow = screen.getByText('mia@karnaf.io').closest('tr')!;
    const roleSelect = miaRow.querySelector('select') as HTMLSelectElement;
    fireEvent.change(roleSelect, { target: { value: 'sales_rep' } });
    await waitFor(() => {
      const firstArg = vi.mocked(postUpdateUser).mock.calls[0]?.[0];
      expect(firstArg).toEqual({ userId: 'user-1', role: 'sales_rep' });
    });
  });

  it('toggles is_active via the checkbox', async () => {
    renderUsers('admin');
    await screen.findByText('mia@karnaf.io', undefined, { timeout: 4000 });
    const miaRow = screen.getByText('mia@karnaf.io').closest('tr')!;
    const checkbox = miaRow.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);
    await waitFor(() => {
      const firstArg = vi.mocked(postUpdateUser).mock.calls[0]?.[0];
      expect(firstArg).toEqual({ userId: 'user-1', isActive: false });
    });
  });

  it('disables the role select and active checkbox for the current user', async () => {
    renderUsers('admin', 'admin-1');
    await screen.findByText('admin@karnaf.io');
    const adminRow = screen.getByText('admin@karnaf.io').closest('tr')!;
    expect(adminRow.querySelector('select')).toBeDisabled();
    expect(adminRow.querySelector('input[type="checkbox"]')).toBeDisabled();
    expect(adminRow.textContent).toContain('(אתה)');
  });
});
