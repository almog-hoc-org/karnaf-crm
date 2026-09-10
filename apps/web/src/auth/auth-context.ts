import { createContext, useContext } from 'react';
import type { Session, User } from '@supabase/supabase-js';

export type Role = 'owner' | 'admin' | 'mia' | 'sales_rep' | 'viewer';

export interface SignUpResult {
  error: string | null;
  needsEmailConfirmation: boolean;
}

export interface AuthState {
  session: Session | null;
  user: User | null;
  role: Role | null;
  loading: boolean;
  /**
   * Set when the profile lookup itself failed (database down, timeout,
   * network) — as opposed to succeeding and finding no active row. The two
   * used to be indistinguishable, so a database outage read as "your
   * profile is not active", which sent the owner hunting for a permissions
   * problem that did not exist.
   */
  profileError: string | null;
  /** Re-run the profile lookup for the current session. */
  reloadProfile: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  signUp: (email: string, password: string) => Promise<SignUpResult>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
