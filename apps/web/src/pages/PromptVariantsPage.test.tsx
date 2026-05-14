import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext, type AuthState, type Role } from '@/auth/auth-context';
import type { PromptVariantRow } from '@/lib/api';
import { PromptVariantsPage } from './PromptVariantsPage';

vi.mock('@/lib/api', () => ({
  fetchPromptVariants: vi.fn(),
  postCreatePromptVariant: vi.fn(),
  postUpdatePromptVariant: vi.fn(),
  postDeletePromptVariant: vi.fn(),
  // PromptVariantsPage also imports this; the rating-stats query is
  // rendered in the per-variant card. Without the mock, page render crashes.
  fetchPromptVariantRatingStats: vi.fn(),
}));

import {
  fetchPromptVariants, postCreatePromptVariant, postUpdatePromptVariant,
  postDeletePromptVariant, fetchPromptVariantRatingStats,
} from '@/lib/api';

function makeVariant(over: Partial<PromptVariantRow> = {}): PromptVariantRow {
  return {
    id: 'pv-1',
    playbook_name: 'qualification',
    version: 'v1',
    weight: 50,
    prompt_overrides: {},
    is_active: true,
    notes: null,
    created_at: '2026-04-20T08:00:00Z',
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

function renderPrompts(role: Role | null = 'admin') {
  return render(
    <QueryClientProvider client={makeClient()}>
      <AuthContext.Provider value={makeAuth(role)}>
        <MemoryRouter initialEntries={['/admin/prompts']}>
          <Routes>
            <Route path="/admin/prompts" element={<PromptVariantsPage />} />
            <Route path="/" element={<div>home outlet</div>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(fetchPromptVariants).mockResolvedValue([
    makeVariant({ id: 'pv-a', version: 'v1', weight: 70 }),
    makeVariant({ id: 'pv-b', version: 'v2', weight: 30, is_active: true }),
    makeVariant({ id: 'pv-c', playbook_name: 'price_objection', version: 'baseline', weight: 100 }),
  ]);
  vi.mocked(postCreatePromptVariant).mockResolvedValue({ ok: true, variant: makeVariant({ id: 'new-1' }) });
  vi.mocked(postUpdatePromptVariant).mockResolvedValue({ ok: true, variant: makeVariant() });
  vi.mocked(postDeletePromptVariant).mockResolvedValue({ ok: true });
  vi.mocked(fetchPromptVariantRatingStats).mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

describe('PromptVariantsPage', () => {
  it('redirects non-admins to home', () => {
    renderPrompts('mia');
    expect(screen.getByText('home outlet')).toBeInTheDocument();
  });

  it('lists variants grouped per playbook for admins', async () => {
    renderPrompts('admin');
    await waitFor(() => expect(screen.getByText('v1')).toBeInTheDocument());
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText('baseline')).toBeInTheDocument();
  });

  it('shows the active-share percentage when multiple active variants compete', async () => {
    renderPrompts('admin');
    await waitFor(() => expect(screen.getByText('v1')).toBeInTheDocument());
    // qualification has v1=70 + v2=30 = 100 active weight; expect 70% and 30%.
    expect(screen.getByText(/70%/)).toBeInTheDocument();
    expect(screen.getByText(/30%/)).toBeInTheDocument();
  });

  it('creates a new variant via the create form', async () => {
    renderPrompts('admin');
    await waitFor(() => expect(screen.getByText('v1')).toBeInTheDocument());

    const versionInput = screen.getByPlaceholderText('v2-friendlier');
    fireEvent.change(versionInput, { target: { value: 'v3-test' } });

    fireEvent.click(screen.getByRole('button', { name: /הוספת גרסה/ }));

    await waitFor(() => expect(vi.mocked(postCreatePromptVariant)).toHaveBeenCalled());
    const arg = vi.mocked(postCreatePromptVariant).mock.calls[0]![0];
    expect(arg.version).toBe('v3-test');
    expect(arg.weight).toBe(50);
    expect(arg.is_active).toBe(true);
  });

  it('toggles is_active via the row checkbox', async () => {
    renderPrompts('admin');
    await waitFor(() => expect(screen.getByText('v1')).toBeInTheDocument());

    // The row containing the v1 code is the one we want; find its checkbox
    // (avoids tripping over the create form's "פעילה מיד" toggle).
    const v1Row = screen.getByText('v1').closest('li')!;
    const rowCheckbox = v1Row.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(rowCheckbox).toBeTruthy();
    fireEvent.click(rowCheckbox);

    await waitFor(() => expect(vi.mocked(postUpdatePromptVariant)).toHaveBeenCalled());
    const arg = vi.mocked(postUpdatePromptVariant).mock.calls[0]![0];
    expect(arg).toMatchObject({ id: 'pv-a', is_active: false });
  });

  it('deletes a variant after confirm', async () => {
    const confirmFn = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmFn);
    renderPrompts('admin');
    await waitFor(() => expect(screen.getByText('v1')).toBeInTheDocument());

    const v1Row = screen.getByText('v1').closest('li')!;
    const deleteButton = Array.from(v1Row.querySelectorAll('button'))
      .find((b) => b.textContent === 'מחיקה') as HTMLButtonElement;
    expect(deleteButton).toBeTruthy();
    fireEvent.click(deleteButton);

    // First: did the click handler reach window.confirm at all?
    expect(confirmFn).toHaveBeenCalledWith(expect.stringContaining('v1'));
    // TanStack Query v5 invokes the mutation function as (variables, context),
    // so we assert on the first positional arg rather than the full call.
    await waitFor(() => expect(vi.mocked(postDeletePromptVariant)).toHaveBeenCalled());
    expect(vi.mocked(postDeletePromptVariant).mock.calls[0]?.[0]).toBe('pv-a');
    vi.unstubAllGlobals();
  });

  it('does not delete when the user cancels the confirm', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    renderPrompts('admin');
    await waitFor(() => expect(screen.getByText('v1')).toBeInTheDocument());

    const v1Row = screen.getByText('v1').closest('li')!;
    const deleteButton = Array.from(v1Row.querySelectorAll('button'))
      .find((b) => b.textContent === 'מחיקה') as HTMLButtonElement;
    fireEvent.click(deleteButton);

    expect(vi.mocked(postDeletePromptVariant)).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
