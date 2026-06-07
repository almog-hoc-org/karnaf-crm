import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext, type AuthState, type Role } from '@/auth/auth-context';
vi.mock('@/pages/DashboardPage', () => ({
  DashboardPage: () => <div>manager dashboard</div>,
}));

import { HomeRoute } from './HomeRoute';

function makeAuth(role: Role | null): AuthState {
  return {
    session: null,
    user: null,
    role,
    loading: false,
    signIn: async () => ({ error: null }),
    signInWithGoogle: async () => ({ error: null }),
    signUp: async () => ({ error: null, needsEmailConfirmation: true }),
    signOut: async () => {},
  } as AuthState;
}

function renderHome(role: Role | null) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={makeAuth(role)}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<HomeRoute />} />
            <Route path="/inbox" element={<div>inbox home</div>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('HomeRoute', () => {
  it('sends sales reps to the operational inbox', () => {
    renderHome('sales_rep');
    expect(screen.getByText('inbox home')).toBeInTheDocument();
  });

  it('sends viewers to the operational inbox', () => {
    renderHome('viewer');
    expect(screen.getByText('inbox home')).toBeInTheDocument();
  });

  it('keeps managers on the dashboard', () => {
    renderHome('mia');
    expect(screen.getByText('manager dashboard')).toBeInTheDocument();
  });
});
