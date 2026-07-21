// CRUD for in-system landing pages (see migration 108). Staff-only —
// the public serving path is the Vercel edge function /api/lp/{slug},
// which reads active rows with the anon key.
//
// GET        → list all pages
// POST create / update / toggle / delete (action in body)

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

const SLUG_RE = /^[a-z0-9-]{2,60}$/;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const correlationId = correlationFromRequest(req);
  let staff;
  try {
    staff = await requireStaff(req, { allow: ['owner', 'admin', 'mia'] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const supabase = getServiceSupabase();

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('landing_pages')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) return jsonResponse(req, { error: error.message }, 500);
    return jsonResponse(req, { ok: true, pages: data ?? [] });
  }

  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action as string | undefined;

  if (action === 'create') {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    const title = String(body.title ?? '').trim();
    const headline = String(body.headline ?? '').trim();
    const campaign = String(body.campaign ?? '').trim();
    if (!SLUG_RE.test(slug)) return jsonResponse(req, { error: 'slug: אותיות קטנות באנגלית, ספרות ומקפים (2-60)' }, 400);
    if (!title || !headline || !campaign) {
      return jsonResponse(req, { error: 'title, headline, campaign required' }, 400);
    }
    const { data, error } = await supabase.from('landing_pages').insert({
      slug,
      title,
      headline,
      subheadline: (body.subheadline as string | undefined)?.trim() || null,
      body_md: (body.body_md as string | undefined)?.trim() || null,
      cta_label: (body.cta_label as string | undefined)?.trim() || 'רוצה שיחזרו אליי',
      campaign,
      form_config: body.form_config ?? { fields: ['name', 'phone', 'email'] },
      active: body.active !== false,
      created_by: staff.userId,
    }).select('*').single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('landing_page_created', { fn: 'landing-pages', correlationId, by: staff.userId, slug });
    return jsonResponse(req, { ok: true, page: data });
  }

  if (action === 'update') {
    const id = body.id as string | undefined;
    if (!id) return jsonResponse(req, { error: 'id required' }, 400);
    const patch: Record<string, unknown> = {};
    if (body.title !== undefined) patch.title = String(body.title).trim();
    if (body.headline !== undefined) patch.headline = String(body.headline).trim();
    if (body.subheadline !== undefined) patch.subheadline = (body.subheadline as string | null)?.trim?.() || null;
    if (body.body_md !== undefined) patch.body_md = (body.body_md as string | null)?.trim?.() || null;
    if (body.cta_label !== undefined) patch.cta_label = String(body.cta_label).trim() || 'רוצה שיחזרו אליי';
    if (body.campaign !== undefined) patch.campaign = String(body.campaign).trim();
    if (body.form_config !== undefined) patch.form_config = body.form_config;
    if (body.active !== undefined) patch.active = !!body.active;
    if (Object.keys(patch).length === 0) return jsonResponse(req, { error: 'no fields to update' }, 400);
    const { data, error } = await supabase
      .from('landing_pages').update(patch).eq('id', id).select('*').single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('landing_page_updated', { fn: 'landing-pages', correlationId, by: staff.userId, id });
    return jsonResponse(req, { ok: true, page: data });
  }

  if (action === 'delete') {
    const id = body.id as string | undefined;
    if (!id) return jsonResponse(req, { error: 'id required' }, 400);
    if (staff.role !== 'owner' && staff.role !== 'admin') {
      return jsonResponse(req, { error: 'delete requires owner/admin' }, 403);
    }
    const { error } = await supabase.from('landing_pages').delete().eq('id', id);
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('landing_page_deleted', { fn: 'landing-pages', correlationId, by: staff.userId, id });
    return jsonResponse(req, { ok: true });
  }

  return jsonResponse(req, { error: 'Unknown action' }, 400);
});
