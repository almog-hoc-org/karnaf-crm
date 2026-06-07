import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthContext, type AuthState, type Role } from '@/auth/auth-context';
import { Layout } from './Layout';

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
  };
}

function renderLayout(opts: RenderOpts = {}) {
  const initialPath = opts.initialPath ?? '/leads';
  return render(
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
    </AuthContext.Provider>,
  );
}

describe('Layout', () => {
  it('renders the always-visible operator nav links and the outlet', () => {
    renderLayout({ role: 'viewer' });
    expect(screen.queryByRole('link', { name: 'היום' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'היום שלי' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'כל הלידים' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'תורים טכניים' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'דוחות' })).not.toBeInTheDocument();
    expect(screen.getByText('leads outlet')).toBeInTheDocument();
  });

  it('keeps manager-level links visible for Mia operators', () => {
    renderLayout({ role: 'mia' });
    expect(screen.getByRole('link', { name: 'היום' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'דוחות' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'משתמשים' })).not.toBeInTheDocument();
  });

  it('hides the admin-only Users link from non-admin roles', () => {
    renderLayout({ role: 'sales_rep' });
    expect(screen.queryByRole('link', { name: 'משתמשים' })).not.toBeInTheDocument();
  });

  it('hides manager and admin links from sales representatives', () => {
    renderLayout({ role: 'sales_rep' });
    expect(screen.queryByRole('link', { name: 'היום' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'דוחות' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'משתמשים' })).not.toBeInTheDocument();
  });

  it('shows the admin-only Users link for admins', () => {
    renderLayout({ role: 'admin' });
    expect(screen.getByRole('link', { name: 'משתמשים' })).toBeInTheDocument();
  });

  it('shows the admin-only Users link for owners', () => {
    renderLayout({ role: 'owner' });
    expect(screen.getByRole('link', { name: 'משתמשים' })).toBeInTheDocument();
  });

  it('renders the user email and role badge', () => {
    renderLayout({ role: 'admin', email: 'admin@karnaf.io' });
    expect(screen.getByText('admin@karnaf.io')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
  });

  it('invokes signOut when the exit button is pressed', () => {
    const signOut = vi.fn(async () => {});
    renderLayout({ role: 'viewer', signOut });
    fireEvent.click(screen.getByRole('button', { name: 'יציאה' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
