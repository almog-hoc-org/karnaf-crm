import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthContext, type AuthState } from './auth-context';
import { ProtectedRoute } from './ProtectedRoute';

function makeAuthState(overrides: Partial<AuthState>): AuthState {
  return {
    session: null,
    user: null,
    role: null,
    loading: false,
    signIn: async () => ({ error: null }),
    signInWithGoogle: async () => ({ error: null }),
    signUp: async () => ({ error: null, needsEmailConfirmation: true }),
    signOut: async () => {},
    profileError: null,
    reloadProfile: async () => {},
    ...overrides,
  };
}

function renderProtected(auth: AuthState, initialPath = '/dashboard') {
  return render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/login" element={<div>login screen</div>} />
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<div>protected content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('ProtectedRoute', () => {
  it('shows a spinner while auth is resolving', () => {
    renderProtected(makeAuthState({ loading: true }));
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
    expect(screen.queryByText('login screen')).not.toBeInTheDocument();
  });

  it('redirects to /login when there is no session', () => {
    renderProtected(makeAuthState({ session: null, role: null, loading: false }));
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
    expect(screen.getByText('login screen')).toBeInTheDocument();
  });

  it('redirects to /login when session exists but role is missing', () => {
    const fakeSession = { user: { id: 'u1' } } as unknown as AuthState['session'];
    renderProtected(makeAuthState({ session: fakeSession, role: null, loading: false }));
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
    expect(screen.getByText('login screen')).toBeInTheDocument();
  });

  it('renders the protected outlet when session and role are present', () => {
    const fakeSession = { user: { id: 'u1' } } as unknown as AuthState['session'];
    renderProtected(makeAuthState({ session: fakeSession, role: 'admin', loading: false }));
    expect(screen.getByText('protected content')).toBeInTheDocument();
    expect(screen.queryByText('login screen')).not.toBeInTheDocument();
  });
});
