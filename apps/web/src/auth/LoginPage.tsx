import { useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from './auth-context';
import { Spinner } from '@/components/Spinner';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { t } from '@/lib/i18n';

type Mode = 'login' | 'signup';

export function LoginPage() {
  const auth = useAuth();
  const [params] = useSearchParams();
  const next = params.get('next') || '/';
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  useDocumentTitle(mode === 'signup' ? t('sign_up') : t('sign_in'));

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setInfo(null);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setInfo(null);
    if (mode === 'login') {
      const { error } = await auth.signIn(email, password);
      setSubmitting(false);
      if (error) setError(error);
    } else {
      if (password.length < 8) {
        setSubmitting(false);
        setError(t('password_too_short'));
        return;
      }
      const { error, needsEmailConfirmation } = await auth.signUp(email, password);
      setSubmitting(false);
      if (error) {
        setError(error);
        return;
      }
      if (needsEmailConfirmation) {
        setInfo(t('email_confirmation_sent'));
        setMode('login');
        setPassword('');
      } else {
        setInfo(t('account_created_pending_admin'));
      }
    }
  }

  async function onGoogleSignIn() {
    setGoogleSubmitting(true);
    setError(null);
    setInfo(null);
    const { error } = await auth.signInWithGoogle();
    if (error) {
      setError(error);
      setGoogleSubmitting(false);
      return;
    }
  }

  // Authenticated users with an active profile bounce to the post-login
  // destination. Users with a session but no role stay here so the warning
  // about "profile not active" is visible.
  if (auth.session && auth.role) {
    const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    return <Navigate to={safeNext} replace />;
  }

  const isSignup = mode === 'signup';
  const submitLabel = isSignup ? t('sign_up') : t('sign_in');
  const submittingLabel = isSignup ? t('signing_up') : t('signing_in');

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden p-4 sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-bl from-brand-50 via-white to-sky-50"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 -end-32 -z-10 h-96 w-96 rounded-full bg-brand-500/15 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-40 -start-32 -z-10 h-96 w-96 rounded-full bg-sky-500/10 blur-3xl"
      />
      <form onSubmit={onSubmit} className="kf-card w-full max-w-sm space-y-5 p-5 shadow-xl sm:p-7">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="grid h-10 w-10 place-items-center rounded-lg bg-brand-600 text-white shadow-sm">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 7l8 5 8-5M4 7v10l8 5 8-5V7M4 7l8-5 8 5" />
            </svg>
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t('app_name')}</h1>
            <p className="text-sm text-slate-500">{isSignup ? t('signup_title') : t('login_title')}</p>
          </div>
        </div>

        <label className="block text-sm">
          <span className="text-slate-700">{t('email_label')}</span>
          <input
            type="email" autoComplete="email" required
            className="kf-input mt-1"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@karnaf.io"
          />
        </label>

        <div className="block text-sm">
          <label htmlFor="login-password" className="text-slate-700">{t('password_label')}</label>
          <div className="relative mt-1">
            <input
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete={isSignup ? 'new-password' : 'current-password'} required
              className="kf-input pe-10"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              aria-label={showPassword ? t('hide_password') : t('show_password')}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((v) => !v)}
              className="absolute inset-y-0 end-2 my-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
                {showPassword ? (
                  <>
                    <path d="M3 3l14 14" strokeLinecap="round" />
                    <path d="M9.5 5.1A9 9 0 0 1 19 10s-1.5 3.2-4.6 4.7M6.7 6.8C4.4 8 3 10 3 10s2.5 5 7 5c1.1 0 2.1-.3 3-.7" />
                    <path d="M9 9.2A1.8 1.8 0 0 0 10 12c.5 0 1-.2 1.4-.6" />
                  </>
                ) : (
                  <>
                    <path d="M2 10s2.5-5 8-5 8 5 8 5-2.5 5-8 5-8-5-8-5Z" />
                    <circle cx="10" cy="10" r="2.3" />
                  </>
                )}
              </svg>
            </button>
          </div>
          {isSignup ? (
            <p className="mt-1 text-xs text-slate-500">{t('password_min_hint')}</p>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
        ) : null}

        {info ? (
          <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{info}</p>
        ) : null}

        {!isSignup ? (
          <button
            type="button"
            className="kf-btn w-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            onClick={onGoogleSignIn}
            disabled={googleSubmitting || submitting}
          >
            {googleSubmitting ? <><Spinner /> {t('sign_in_with_google')}</> : t('sign_in_with_google')}
          </button>
        ) : null}

        <button type="submit" className="kf-btn kf-btn-primary w-full" disabled={submitting || googleSubmitting}>
          {submitting ? <><Spinner /> {submittingLabel}</> : submitLabel}
        </button>

        <p className="text-center text-sm text-slate-600">
          {isSignup ? (
            <>
              {t('has_account')}{' '}
              <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => switchMode('login')}>
                {t('sign_in')}
              </button>
            </>
          ) : (
            <>
              {t('no_account')}{' '}
              <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => switchMode('signup')}>
                {t('sign_up')}
              </button>
            </>
          )}
        </p>

        {auth.session && !auth.role ? (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {t('user_no_active_profile')}
          </p>
        ) : null}
      </form>
    </main>
  );
}
