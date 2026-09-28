import { createContext, useContext } from 'react';
import type { Session, User } from '@supabase/supabase-js';

export type Role = 'owner' | 'admin' | 'mia' | 'sales_rep' | 'viewer';

// What the header, the 🔒 page and the permissions help call each role.
// The raw enum ("owner", "sales_rep") used to be printed as-is.
export const ROLE_LABELS: Record<Role, string> = {
  owner: 'בעלים',
  admin: 'מנהל/ת',
  mia: 'מפעיל/ת ראשי/ת',
  sales_rep: 'נציג/ת מכירות',
  viewer: 'צופה',
};

export function roleLabel(role: Role | null | undefined): string {
  return role ? ROLE_LABELS[role] ?? role : 'לא ידוע';
}

// Manager = runs the business screens (reports, broadcasts, automations).
// Admin = also system configuration and users.
export const MANAGER_ROLES: Role[] = ['owner', 'admin', 'mia'];
export const ADMIN_ROLES: Role[] = ['owner', 'admin'];
export const isManagerRole = (role: Role | null | undefined): boolean => !!role && MANAGER_ROLES.includes(role);
export const isAdminRole = (role: Role | null | undefined): boolean => !!role && ADMIN_ROLES.includes(role);

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
