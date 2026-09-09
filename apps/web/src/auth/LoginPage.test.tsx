import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthContext, type AuthState, type Role } from './auth-context';
import { LoginPage } from './LoginPage';

interface RenderOpts {
  session?: AuthState['session'];
  role?: Role | null;
  loading?: boolean;
  profileError?: string | null;
  reloadProfile?: AuthState['reloadProfile'];
  signOut?: AuthState['signOut'];
  signIn?: AuthState['signIn'];
  signInWithGoogle?: AuthState['signInWithGoogle'];
  signUp?: AuthState['signUp'];
}

function makeAuth({
  session = null,
  role = null,
  loading = false,
  profileError = null,
  reloadProfile = async () => {},
  signOut = async () => {},
  signIn = async () => ({ error: null }),
  signInWithGoogle = async () => ({ error: null }),
  signUp = async () => ({ error: null, needsEmailConfirmation: true }),
}: RenderOpts): AuthState {
  return {
    session,
    user: session?.user ?? null,
    role,
    loading,
    signIn,
    signInWithGoogle,
    signUp,
    signOut,
    profileError,
    reloadProfile,
  };
}

function renderLogin(opts: RenderOpts = {}) {
  return render(
    <AuthContext.Provider value={makeAuth(opts)}>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>home outlet</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('LoginPage', () => {
  it('renders the form with Hebrew labels and submit button', () => {
    renderLogin();
    expect(screen.getByRole('heading', { name: 'Karnaf CRM' })).toBeInTheDocument();
    expect(screen.getByText('כניסת מפעיל')).toBeInTheDocument();
    expect(screen.getByText('אימייל')).toBeInTheDocument();
    expect(screen.getByText('סיסמה')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'כניסה עם גוגל' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'התחברות' })).toBeInTheDocument();
  });

  it('redirects authenticated users with an active role away from the login screen', () => {
    const fakeSession = { user: { id: 'u1' } } as unknown as AuthState['session'];
    renderLogin({ session: fakeSession, role: 'admin' });
    expect(screen.queryByRole('button', { name: 'התחברות' })).not.toBeInTheDocument();
    expect(screen.getByText('home outlet')).toBeInTheDocument();
  });

  it('keeps the form visible when session exists but role is missing (deactivated profile) and shows the warning', () => {
    const fakeSession = { user: { id: 'u1' } } as unknown as AuthState['session'];
    renderLogin({ session: fakeSession, role: null });
    expect(screen.getByRole('button', { name: 'התחברות' })).toBeInTheDocument();
    expect(screen.getByText(/אין לו פרופיל פעיל/)).toBeInTheDocument();
  });

  it('says nothing about the profile while the lookup is still running', () => {
    const fakeSession = { user: { id: 'u1' } } as unknown as AuthState['session'];
    renderLogin({ session: fakeSession, role: null, loading: true });
    expect(screen.queryByText(/אין לו פרופיל פעיל/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a server-error box with retry when the profile lookup failed, not the "inactive" warning', async () => {
    const fakeSession = { user: { id: 'u1' } } as unknown as AuthState['session'];
    const reloadProfile = vi.fn(async () => {});
    renderLogin({ session: fakeSession, role: null, profileError: 'connection timeout', reloadProfile });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/לא הצלחנו לטעון את הפרופיל/);
    expect(alert).toHaveTextContent('connection timeout');
    expect(screen.queryByText(/אין לו פרופיל פעיל/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'נסו שוב' }));
    await waitFor(() => expect(reloadProfile).toHaveBeenCalledTimes(1));
  });

  it('offers sign-out to a signed-in user who is stuck on the login screen', async () => {
    const fakeSession = { user: { id: 'u1' } } as unknown as AuthState['session'];
    const signOut = vi.fn(async () => {});
    renderLogin({ session: fakeSession, role: null, signOut });
    fireEvent.click(screen.getByRole('button', { name: 'יציאה' }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it('calls signIn with the entered credentials on submit', async () => {
    const signIn = vi.fn(async () => ({ error: null }));
    renderLogin({ signIn });
    fireEvent.change(screen.getByLabelText('אימייל'), { target: { value: 'op@karnaf.io' } });
    fireEvent.change(screen.getByLabelText('סיסמה'), { target: { value: 'sup3rsecret!' } });
    fireEvent.click(screen.getByRole('button', { name: 'התחברות' }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith('op@karnaf.io', 'sup3rsecret!'));
  });

  it('shows the error message when signIn returns an error', async () => {
    const signIn = vi.fn(async () => ({ error: 'Invalid credentials' }));
    renderLogin({ signIn });
    fireEvent.change(screen.getByLabelText('אימייל'), { target: { value: 'op@karnaf.io' } });
    fireEvent.change(screen.getByLabelText('סיסמה'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'התחברות' }));
    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
  });

  it('calls signInWithGoogle when the Google button is pressed', async () => {
    const signInWithGoogle = vi.fn(async () => ({ error: null }));
    renderLogin({ signInWithGoogle });
    fireEvent.click(screen.getByRole('button', { name: 'כניסה עם גוגל' }));
    await waitFor(() => expect(signInWithGoogle).toHaveBeenCalledTimes(1));
  });

  it('switches to signup mode and calls signUp on submit', async () => {
    const signUp = vi.fn(async () => ({ error: null, needsEmailConfirmation: true }));
    renderLogin({ signUp });
    fireEvent.click(screen.getByRole('button', { name: 'הרשמה' }));
    expect(screen.getByText('יצירת משתמש חדש')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('אימייל'), { target: { value: 'new@karnaf.io' } });
    fireEvent.change(screen.getByLabelText('סיסמה'), { target: { value: 'sup3rsecret!' } });
    fireEvent.click(screen.getByRole('button', { name: 'הרשמה' }));
    await waitFor(() => expect(signUp).toHaveBeenCalledWith('new@karnaf.io', 'sup3rsecret!'));
    expect(await screen.findByText(/נשלח אימייל לאימות/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'התחברות' })).toBeInTheDocument();
  });

  it('rejects signup passwords shorter than 8 characters without calling signUp', async () => {
    const signUp = vi.fn(async () => ({ error: null, needsEmailConfirmation: true }));
    renderLogin({ signUp });
    fireEvent.click(screen.getByRole('button', { name: 'הרשמה' }));
    fireEvent.change(screen.getByLabelText('אימייל'), { target: { value: 'new@karnaf.io' } });
    fireEvent.change(screen.getByLabelText('סיסמה'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'הרשמה' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/לפחות 8 תווים/);
    expect(signUp).not.toHaveBeenCalled();
  });

  it('shows the error message when signUp returns an error', async () => {
    const signUp = vi.fn(async () => ({ error: 'Email already registered', needsEmailConfirmation: false }));
    renderLogin({ signUp });
    fireEvent.click(screen.getByRole('button', { name: 'הרשמה' }));
    fireEvent.change(screen.getByLabelText('אימייל'), { target: { value: 'dupe@karnaf.io' } });
    fireEvent.change(screen.getByLabelText('סיסמה'), { target: { value: 'sup3rsecret!' } });
    fireEvent.click(screen.getByRole('button', { name: 'הרשמה' }));
    expect(await screen.findByText('Email already registered')).toBeInTheDocument();
  });
});
