import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { AuthContext, type AuthState, type Role } from './auth-context';

// One profile fetch may take this long before it counts as failed. Without
// a bound, a database that accepts the connection and never answers left
// the app on its spinner indefinitely.
export const PROFILE_TIMEOUT_MS = 15_000;

// One quiet retry before reporting. A database that is restarting answers
// the second request far more often than the first, and the owner should
// not see an error for a blip that heals itself in two seconds.
export const PROFILE_RETRY_DELAY_MS = 2_000;

interface ProfileResult {
  role: Role | null;
  error: string | null;
}

async function fetchProfile(userId: string): Promise<ProfileResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROFILE_TIMEOUT_MS);
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('role, is_active')
      .eq('id', userId)
      .abortSignal(controller.signal)
      .maybeSingle();
    if (error) return { role: null, error: error.message };
    // No row, or an inactive one, is a real answer — not an error. The
    // login screen tells the user to contact an admin in that case.
    return { role: data && data.is_active ? (data.role as Role) : null, error: null };
  } catch (err) {
    return { role: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Every profile load bumps this; a load that finishes after a newer one
  // started (or after sign-out) discards its result instead of clobbering.
  const generation = useRef(0);
  const profileErrorRef = useRef<string | null>(null);
  profileErrorRef.current = profileError;

  const loadProfile = useCallback(async (userId: string) => {
    const gen = ++generation.current;
    setLoading(true);
    let result = await fetchProfile(userId);
    if (result.error && gen === generation.current) {
      await sleep(PROFILE_RETRY_DELAY_MS);
      if (gen !== generation.current) return;
      result = await fetchProfile(userId);
    }
    if (gen !== generation.current) return;
    setRole(result.role);
    setProfileError(result.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      // No persisted session → nothing to load. Releasing `loading` here
      // (rather than in the role-fetch effect) keeps ProtectedRoute on its
      // spinner while getSession is still in flight, so deep links like
      // /leads/<id> aren't bounced through /login on a hard refresh.
      if (!data.session) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (!next) {
        setLoading(false);
        return;
      }
      // The role effect below keys on the user id, so a refreshed token for
      // the same user does not re-run it. If the last lookup failed, use
      // the refresh as the cue to try again: an open tab heals itself once
      // the database is back instead of staying broken until a hard reload.
      if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && profileErrorRef.current) {
        void loadProfile(next.user.id);
      }
    });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, [loadProfile]);

  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) {
      generation.current++;
      setRole(null);
      setProfileError(null);
      return;
    }
    void loadProfile(userId);
    // session.user.id is the only field we depend on here.
  }, [session?.user?.id, loadProfile]);

  const value = useMemo<AuthState>(() => ({
    session,
    user: session?.user ?? null,
    role,
    loading,
    profileError,
    async reloadProfile() {
      const userId = session?.user?.id;
      if (userId) await loadProfile(userId);
    },
    async signIn(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return { error: error?.message ?? null };
    },
    async signInWithGoogle() {
      const redirectTo = `${window.location.origin}/`;
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      });
      return { error: error?.message ?? null };
    },
    async signUp(email, password) {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) return { error: error.message, needsEmailConfirmation: false };
      // When email confirmations are enabled in Supabase, signUp returns a user
      // but no session — the user must click the verification link before they
      // can sign in. With confirmations disabled, a session is returned and
      // onAuthStateChange will pick it up.
      const needsEmailConfirmation = !data.session;
      return { error: null, needsEmailConfirmation };
    },
    async signOut() {
      await supabase.auth.signOut();
    },
  }), [session, role, loading, profileError, loadProfile]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
