// CRUD for the lead_sources registry. Owner/admin only.
// GET   → list all sources (active first, then by sort_order)
// POST  → create | update | toggle | delete (action in body)

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

interface CreatePayload {
  action: 'create';
  slug: string;
  display_name: string;
  sort_order?: number;
}
interface UpdatePayload {
  action: 'update';
  slug: string;
  display_name?: string;
  is_active?: boolean;
  sort_order?: number;
}
interface DeletePayload {
  action: 'delete';
  slug: string;
}
type Payload = CreatePayload | UpdatePayload | DeletePayload;

const SLUG_RE = /^[a-z][a-z0-9_]{1,39}$/;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const correlationId = correlationFromRequest(req);

  let staff;
  try {
    staff = await requireStaff(req, { allow: ['owner', 'admin'] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const supabase = getServiceSupabase();

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('lead_sources')
      .select('slug, display_name, is_active, sort_order, created_at, updated_at, intake_source_contracts(contract_key, display_name, default_track, default_stage, required_fields, is_active)')
      .order('is_active', { ascending: false })
      .order('sort_order', { ascending: true });
    if (error) return jsonResponse(req, { error: error.message }, 500);
    return jsonResponse(req, { ok: true, sources: data ?? [] });
  }

  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const body = (await req.json().catch(() => ({}))) as Payload;

  if (body.action === 'create') {
    if (!body.slug || !SLUG_RE.test(body.slug)) {
      return jsonResponse(req, { error: 'Slug must be lowercase a-z0-9_ (2-40 chars, leading letter)' }, 400);
    }
    if (!body.display_name || body.display_name.trim().length === 0) {
      return jsonResponse(req, { error: 'display_name required' }, 400);
    }
    const { data, error } = await supabase
      .from('lead_sources')
      .insert({
        slug: body.slug,
        display_name: body.display_name.trim(),
        sort_order: body.sort_order ?? 100,
      })
      .select('slug, display_name, is_active, sort_order, created_at, updated_at')
      .single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('lead_source_created', { fn: 'lead-sources', correlationId, by: staff.userId, slug: body.slug });
    return jsonResponse(req, { ok: true, source: data });
  }

  if (body.action === 'update') {
    if (!body.slug) return jsonResponse(req, { error: 'slug required' }, 400);
    const updates: Record<string, unknown> = {};
    if (body.display_name !== undefined) updates.display_name = body.display_name.trim();
    if (body.is_active !== undefined) updates.is_active = body.is_active;
    if (body.sort_order !== undefined) updates.sort_order = body.sort_order;
    if (Object.keys(updates).length === 0) {
      return jsonResponse(req, { error: 'no fields to update' }, 400);
    }
    const { data, error } = await supabase
      .from('lead_sources')
      .update(updates)
      .eq('slug', body.slug)
      .select('slug, display_name, is_active, sort_order, created_at, updated_at')
      .single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('lead_source_updated', { fn: 'lead-sources', correlationId, by: staff.userId, slug: body.slug });
    return jsonResponse(req, { ok: true, source: data });
  }

  if (body.action === 'delete') {
    if (!body.slug) return jsonResponse(req, { error: 'slug required' }, 400);
    if (body.slug === 'unknown') {
      return jsonResponse(req, { error: 'cannot delete the unknown fallback source' }, 400);
    }
    const { error } = await supabase.from('lead_sources').delete().eq('slug', body.slug);
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('lead_source_deleted', { fn: 'lead-sources', correlationId, by: staff.userId, slug: body.slug });
    return jsonResponse(req, { ok: true });
  }

  return jsonResponse(req, { error: 'Unsupported action' }, 400);
});
