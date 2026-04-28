import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { AuthContext, type AuthState, type Role } from './auth-context';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);

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
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) setLoading(false);
    });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!session?.user) { setRole(null); return; }
    setLoading(true);
    supabase
      .from('profiles')
      .select('role, is_active')
      .eq('id', session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setRole(data && data.is_active ? (data.role as Role) : null);
        setLoading(false);
      });
    return () => { cancelled = true; };
    // session.user.id is the only field we depend on here.
  }, [session?.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = useMemo<AuthState>(() => ({
    session,
    user: session?.user ?? null,
    role,
    loading,
    async signIn(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
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
  }), [session, role, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
