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
  // UsersPage also imports these; without them the page crashes during
  // initial render (admin invite + reset-password buttons reference both).
  postResetUserPassword: vi.fn(),
  postInviteUser: vi.fn(),
}));

import {
  fetchUsersList, postCreateUser, postUpdateUser,
  postResetUserPassword, postInviteUser,
} from '@/lib/api';

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
  };
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function renderUsers(role: Role | null = 'admin', userId = 'admin-1') {
  return render(
    <QueryClientProvider client={makeClient()}>
      <AuthContext.Provider value={makeAuth(role, userId)}>
        <MemoryRouter initialEntries={['/admin/users']}>
          <Routes>
            <Route path="/admin/users" element={<UsersPage />} />
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
  vi.mocked(postResetUserPassword).mockResolvedValue({
    ok: true,
    recoveryLink: 'https://karnaf-crm.vercel.app/auth/reset?token=t1',
    email: 'mia@karnaf.io',
  });
  vi.mocked(postInviteUser).mockResolvedValue({
    ok: true,
    inviteLink: 'https://karnaf-crm.vercel.app/auth/invite?token=i1',
    email: 'mia@karnaf.io',
    profile: makeProfile(),
  });
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

  it('renders the user list and the invite form for admins', async () => {
    renderUsers('admin');
    expect(await screen.findByRole('heading', { name: 'ניהול משתמשים' })).toBeInTheDocument();
    expect(await screen.findByText('mia@karnaf.io', undefined, { timeout: 4000 })).toBeInTheDocument();
    // Default mode is "invite" — button label reflects that. Create mode is
    // still available behind the radio toggle (covered by the next test).
    expect(screen.getByRole('button', { name: 'שלח הזמנה' })).toBeInTheDocument();
  });

  it('submits the create form with the entered values', async () => {
    renderUsers('admin');
    await screen.findByRole('heading', { name: 'ניהול משתמשים' });
    // Flip the radio from invite → create so the password input appears
    // and the submit button switches to "הוספת משתמש".
    const createRadio = screen.getByRole('radio', { name: /צור עם סיסמה ידנית/ });
    fireEvent.click(createRadio);
    const submitBtn = await screen.findByRole('button', { name: 'הוספת משתמש' });
    const form = submitBtn.closest('form')!;
    const inputs = form.querySelectorAll('input[type="email"], input[type="password"], input[type="text"], input:not([type])');
    // inputs after the two radios: email, password, fullName.
    const emailInput = form.querySelector('input[type="email"]') as HTMLInputElement;
    const passwordInput = form.querySelector('input[type="password"]') as HTMLInputElement;
    const fullNameInput = inputs[inputs.length - 1] as HTMLInputElement;
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

  // Note: a "submits the invite form" parallel test exists in the e2e
  // suite (e2e/admin-invite.spec.ts) where HTML5 form validation behaves
  // closer to a real browser. The unit-test counterpart is brittle because
  // jsdom + radio-toggled conditional renders don't reliably fire submit.

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
