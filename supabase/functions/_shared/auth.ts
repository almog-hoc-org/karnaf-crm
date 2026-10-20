import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.117.2';
import { getRequestSupabase } from './supabase.ts';

export type StaffRole = 'owner' | 'admin' | 'mia' | 'sales_rep' | 'viewer';

export interface AuthenticatedStaff {
  userId: string;
  email: string | null;
  fullName: string | null;
  role: StaffRole;
  client: SupabaseClient;
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const writerRoles: StaffRole[] = ['owner', 'admin', 'mia', 'sales_rep'];

export async function requireStaff(
  req: Request,
  options: { allow?: StaffRole[]; requireWrite?: boolean } = {},
): Promise<AuthenticatedStaff> {
  const header = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    throw new AuthError(401, 'Missing bearer token');
  }
  const jwt = header.slice(7).trim();
  if (!jwt) throw new AuthError(401, 'Empty bearer token');

  const client = getRequestSupabase(jwt);
  const { data: userData, error: userErr } = await client.auth.getUser(jwt);
  if (userErr || !userData?.user) throw new AuthError(401, 'Invalid token');

  const userId = userData.user.id;
  const email = userData.user.email ?? null;

  const { data: profile, error: profileErr } = await client
    .from('profiles')
    .select('role, is_active, full_name')
    .eq('id', userId)
    .maybeSingle();

  if (profileErr) throw new AuthError(500, profileErr.message);
  if (!profile || !profile.is_active) throw new AuthError(403, 'No active profile');

  const role = profile.role as StaffRole;
  const allow = options.allow ?? (options.requireWrite ? writerRoles : ['owner', 'admin', 'mia', 'sales_rep', 'viewer']);
  if (!allow.includes(role)) throw new AuthError(403, `Role '${role}' not permitted`);

  return { userId, email, fullName: profile.full_name ?? null, role, client };
}
