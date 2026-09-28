// Auth for owner-facing diagnostic endpoints that the ops workflow also
// calls: an owner/admin JWT, or the project's service-role key.
//
// SAFETY: only for functions with `verify_jwt = true` in config.toml. The
// gateway verifies the JWT signature before the function runs, which is
// what makes trusting the `role` claim below safe. A function with
// verify_jwt = false must NOT use this helper.

import { env, safeEqual } from './env.ts';
import { requireStaff, type StaffRole } from './auth.ts';

export type ServiceOrStaffCaller =
  | { kind: 'service' }
  | { kind: 'staff'; email: string | null; userId: string };

/** Claims of a JWT whose signature the gateway has already verified. */
function verifiedClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function authenticateServiceOrStaff(
  req: Request,
  allow: StaffRole[] = ['owner', 'admin'],
): Promise<ServiceOrStaffCaller> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const serviceKey = env.serviceRoleKey();
  if (token && serviceKey && safeEqual(token, serviceKey)) return { kind: 'service' };
  // The service-role key the Management API hands out is not always
  // byte-identical to the one injected into the function env (first ops run
  // on 28.9: 401), so fall back to the gateway-verified role claim.
  const claims = token ? verifiedClaims(token) : null;
  const projectRef = new URL(env.supabaseUrl()).hostname.split('.')[0];
  if (claims?.role === 'service_role' && (claims.ref === undefined || claims.ref === projectRef)) {
    return { kind: 'service' };
  }
  const staff = await requireStaff(req, { allow });
  return { kind: 'staff', email: staff.email, userId: staff.userId };
}
