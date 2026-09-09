import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, PROFILE_RETRY_DELAY_MS } from './AuthProvider';
import { useAuth } from './auth-context';

// The provider talks to supabase-js directly; stand in for the two surfaces
// it uses — auth session events and the profiles query chain.
const mocks = vi.hoisted(() => {
  type Listener = (event: string, session: unknown) => void;
  const state = {
    session: null as unknown,
    listener: null as Listener | null,
  };
  const maybeSingle = vi.fn();
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    abortSignal: vi.fn(() => chain),
    maybeSingle,
  };
  const supabase = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: state.session } })),
      onAuthStateChange: vi.fn((cb: Listener) => {
        state.listener = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      signInWithPassword: vi.fn(),
      signInWithOAuth: vi.fn(),
      signUp: vi.fn(),
      signOut: vi.fn(),
    },
    from: vi.fn(() => chain),
  };
  return { state, maybeSingle, supabase };
});

vi.mock('@/lib/supabase', () => ({ supabase: mocks.supabase }));

vi.mock('./AuthProvider', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./AuthProvider')>();
  return mod;
});

const SESSION = { user: { id: 'u1' } };

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(auth.loading)}</span>
      <span data-testid="role">{auth.role ?? 'none'}</span>
      <span data-testid="error">{auth.profileError ?? 'none'}</span>
      <button onClick={() => void auth.reloadProfile()}>reload</button>
    </div>
  );
}

function renderProvider() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

const ok = (role: string, is_active = true) => ({ data: { role, is_active }, error: null });
const failed = (message: string) => ({ data: null, error: { message } });

// The provider retries once after PROFILE_RETRY_DELAY_MS (real time), so
// the failure cases give waitFor room for that delay to elapse.
const RETRY = { timeout: PROFILE_RETRY_DELAY_MS * 3 };

describe('AuthProvider profile lookup', () => {
  beforeEach(() => {
    mocks.state.session = SESSION;
    mocks.state.listener = null;
    mocks.maybeSingle.mockReset();
  });

  it('loads the role from an active profile row', async () => {
    mocks.maybeSingle.mockResolvedValue(ok('owner'));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('role')).toHaveTextContent('owner');
    expect(screen.getByTestId('error')).toHaveTextContent('none');
    expect(mocks.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('treats a missing or inactive row as "no role", not as an error', async () => {
    mocks.maybeSingle.mockResolvedValue(ok('owner', false));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('role')).toHaveTextContent('none');
    expect(screen.getByTestId('error')).toHaveTextContent('none');
  });

  it('surfaces a query error as profileError after one retry, and stops loading', async () => {
    mocks.maybeSingle.mockResolvedValue(failed('connection timeout'));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'), RETRY);
    expect(screen.getByTestId('error')).toHaveTextContent('connection timeout');
    expect(screen.getByTestId('role')).toHaveTextContent('none');
    expect(mocks.maybeSingle).toHaveBeenCalledTimes(2);
  });

  it('recovers when the retry succeeds', async () => {
    mocks.maybeSingle
      .mockResolvedValueOnce(failed('connection timeout'))
      .mockResolvedValueOnce(ok('admin'));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('admin'), RETRY);
    expect(screen.getByTestId('error')).toHaveTextContent('none');
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
  });

  it('never leaves the app on the spinner when the query throws', async () => {
    mocks.maybeSingle.mockRejectedValue(new Error('fetch failed'));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'), RETRY);
    expect(screen.getByTestId('error')).toHaveTextContent('fetch failed');
  });

  it('reloadProfile clears the error once the server answers', async () => {
    mocks.maybeSingle.mockResolvedValue(failed('boom'));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('boom'), RETRY);

    mocks.maybeSingle.mockResolvedValue(ok('owner'));
    fireEvent.click(screen.getByText('reload'));
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('owner'));
    expect(screen.getByTestId('error')).toHaveTextContent('none');
  });

  it('retries on TOKEN_REFRESHED while an error is standing, so an open tab heals itself', async () => {
    mocks.maybeSingle.mockResolvedValue(failed('boom'));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('boom'), RETRY);

    mocks.maybeSingle.mockResolvedValue(ok('owner'));
    await act(async () => { mocks.state.listener?.('TOKEN_REFRESHED', SESSION); });
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('owner'));
    expect(screen.getByTestId('error')).toHaveTextContent('none');
  });

  it('does not query profiles at all without a session', async () => {
    mocks.state.session = null;
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
    expect(screen.getByTestId('role')).toHaveTextContent('none');
  });
});
