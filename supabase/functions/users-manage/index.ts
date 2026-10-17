// Owner/admin-only profile management. Lists profiles, creates new auth
// users (email+password), and updates role / active flag. Anything that
// touches auth.users uses the supabase admin API and therefore must run
// with service-role privilege server-side.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

const ROLES = new Set(['owner', 'admin', 'mia', 'sales_rep', 'viewer']);

interface CreatePayload {
  action: 'create';
  email: string;
  password: string;
  fullName?: string | null;
  role: string;
}
interface UpdatePayload {
  action: 'update';
  userId: string;
  role?: string;
  isActive?: boolean;
  fullName?: string | null;
  password?: string;
}
type Payload = CreatePayload | UpdatePayload;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const correlationId = correlationFromRequest(req);

  let staff;
  try {
    // mia may READ the list (the bulk "assign owner" picker needs the
    // assignable staff); every write below is owner/admin.
    staff = await requireStaff(req, { allow: ['owner', 'admin', 'mia'] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const supabase = getServiceSupabase();

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, role, is_active, created_at, updated_at')
      .order('created_at', { ascending: false });
    if (error) return jsonResponse(req, { error: error.message }, 500);
    return jsonResponse(req, { ok: true, profiles: data ?? [] });
  }

  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);
  if (staff.role !== 'owner' && staff.role !== 'admin') {
    return jsonResponse(req, { error: 'ניהול משתמשים פתוח לבעלים ולמנהלים בלבד' }, 403);
  }

  const body = (await req.json().catch(() => ({}))) as Payload;

  if (body.action === 'create') {
    if (!body.email || !body.password || !body.role) {
      return jsonResponse(req, { error: 'Missing email, password, or role' }, 400);
    }
    if (!ROLES.has(body.role)) return jsonResponse(req, { error: 'Invalid role' }, 400);
    if (body.password.length < 12) return jsonResponse(req, { error: 'Password too short (>=12)' }, 400);
    // Only an owner can mint another owner.
    if (body.role === 'owner' && staff.role !== 'owner') {
      return jsonResponse(req, { error: 'רק בעלים יכול ליצור משתמש בתפקיד בעלים' }, 403);
    }

    const created = await supabase.auth.admin.createUser({
      email: body.email,
      password: body.password,
      email_confirm: true,
    });
    if (created.error) return jsonResponse(req, { error: created.error.message }, 400);

    const userId = created.data.user!.id;
    const profileUpsert = await supabase
      .from('profiles')
      .upsert({
        id: userId,
        email: body.email,
        full_name: body.fullName ?? null,
        role: body.role,
        is_active: true,
      })
      .select('id, email, full_name, role, is_active')
      .single();
    if (profileUpsert.error) return jsonResponse(req, { error: profileUpsert.error.message }, 500);

    log.info('user_created', { fn: 'users-manage', correlationId, by: staff.userId, target: userId, role: body.role });
    return jsonResponse(req, { ok: true, profile: profileUpsert.data });
  }

  if (body.action === 'update') {
    if (!body.userId) return jsonResponse(req, { error: 'Missing userId' }, 400);
    const updates: Record<string, unknown> = {};
    if (body.role !== undefined) {
      if (!ROLES.has(body.role)) return jsonResponse(req, { error: 'Invalid role' }, 400);
      updates.role = body.role;
    }
    if (body.isActive !== undefined) updates.is_active = body.isActive;
    if (body.fullName !== undefined) updates.full_name = body.fullName;

    // Privilege boundary. Before this check an admin could POST
    // {userId: <owner>, password: '...'} and own the owner's login, or
    // {userId: <self>, role: 'owner'} and promote themselves. The rules:
    //   - only an owner may touch an owner (role, active flag, password)
    //     or hand out the owner role;
    //   - nobody changes their own role or deactivates themselves;
    //   - the last active owner cannot be demoted or deactivated.
    const { data: target, error: targetErr } = await supabase
      .from('profiles').select('id, role, is_active').eq('id', body.userId).maybeSingle();
    if (targetErr) return jsonResponse(req, { error: targetErr.message }, 500);
    if (!target) return jsonResponse(req, { error: 'User not found' }, 404);
    const privileged = body.role !== undefined || body.isActive !== undefined || body.password !== undefined;
    if (privileged && (target.role === 'owner' || body.role === 'owner') && staff.role !== 'owner') {
      return jsonResponse(req, { error: 'רק בעלים יכול לשנות משתמש בתפקיד בעלים או להעניק תפקיד בעלים' }, 403);
    }
    if (body.userId === staff.userId) {
      if (body.role !== undefined && body.role !== staff.role) {
        return jsonResponse(req, { error: 'אי אפשר לשנות את התפקיד של עצמך' }, 403);
      }
      if (body.isActive === false) {
        return jsonResponse(req, { error: 'אי אפשר להשבית את המשתמש של עצמך' }, 403);
      }
    }
    const losesOwner = target.role === 'owner' && target.is_active &&
      ((body.role !== undefined && body.role !== 'owner') || body.isActive === false);
    if (losesOwner) {
      const { count } = await supabase
        .from('profiles').select('id', { count: 'exact', head: true })
        .eq('role', 'owner').eq('is_active', true);
      if ((count ?? 0) <= 1) {
        return jsonResponse(req, { error: 'זה הבעלים הפעיל האחרון — אי אפשר להוריד אותו' }, 409);
      }
    }

    if (body.password !== undefined) {
      if (body.password.length < 12) return jsonResponse(req, { error: 'Password too short (>=12)' }, 400);
      const authUpdate = await supabase.auth.admin.updateUserById(body.userId, {
        password: body.password,
      });
      if (authUpdate.error) return jsonResponse(req, { error: authUpdate.error.message }, 400);
    }

    let data;
    if (Object.keys(updates).length > 0) {
      const profileUpdate = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', body.userId)
        .select('id, email, full_name, role, is_active')
        .single();
      if (profileUpdate.error) return jsonResponse(req, { error: profileUpdate.error.message }, 500);
      data = profileUpdate.data;
    } else {
      const profileRead = await supabase
        .from('profiles')
        .select('id, email, full_name, role, is_active')
        .eq('id', body.userId)
        .single();
      if (profileRead.error) return jsonResponse(req, { error: profileRead.error.message }, 500);
      data = profileRead.data;
    }

    log.info('user_updated', {
      fn: 'users-manage', correlationId, by: staff.userId, target: body.userId,
      updates: { ...updates, password: body.password !== undefined ? '[updated]' : undefined },
    });
    return jsonResponse(req, { ok: true, profile: data });
  }

  return jsonResponse(req, { error: 'Unsupported action' }, 400);
});
