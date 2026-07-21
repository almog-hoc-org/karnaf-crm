// CRUD for the message_templates registry. Owner/admin/mia.
//
// GET   → list all templates (with optional channel + status filter)
// POST  → create | update | archive (action in body)

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { sanitizeEmailHtml } from '../_shared/email-html.ts';

interface CreatePayload {
  action: 'create';
  key: string;
  channel: 'whatsapp' | 'sms' | 'email';
  name_he: string;
  body: string;
  description?: string;
  variables_used?: string[];
  tags?: string[];
  notes?: string;
  subject?: string;
  body_html?: string;
}
interface UpdatePayload {
  action: 'update';
  id: string;
  name_he?: string;
  body?: string;
  description?: string;
  variables_used?: string[];
  tags?: string[];
  status?: 'draft' | 'active' | 'deprecated';
  notes?: string;
  subject?: string;
  body_html?: string;
}
type Payload = CreatePayload | UpdatePayload;

const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;

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
    const url = new URL(req.url);
    const channel = url.searchParams.get('channel');
    const status = url.searchParams.get('status');
    let query = supabase
      .from('message_templates')
      .select('*')
      .order('channel')
      .order('key');
    if (channel) query = query.eq('channel', channel);
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) return jsonResponse(req, { error: error.message }, 500);
    return jsonResponse(req, { ok: true, templates: data ?? [] });
  }

  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const body = (await req.json().catch(() => ({}))) as Payload;

  if (body.action === 'create') {
    if (!body.key || !KEY_RE.test(body.key)) {
      return jsonResponse(req, { error: 'key must be lowercase a-z0-9_ (2-40 chars, leading letter)' }, 400);
    }
    if (!body.body || body.body.trim().length === 0) {
      return jsonResponse(req, { error: 'body required' }, 400);
    }
    if (!body.name_he || body.name_he.trim().length === 0) {
      return jsonResponse(req, { error: 'name_he required' }, 400);
    }
    const { data, error } = await supabase
      .from('message_templates')
      .insert({
        key: body.key,
        channel: body.channel,
        name_he: body.name_he.trim(),
        body: body.body,
        description: body.description?.trim() || null,
        variables_used: body.variables_used ?? [],
        tags: body.tags ?? [],
        notes: body.notes?.trim() || null,
        subject: body.subject?.trim() || null,
        // Never trust client HTML, even from staff — sanitize on write.
        body_html: body.body_html ? sanitizeEmailHtml(body.body_html) : null,
      })
      .select('*')
      .single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('template_created', { fn: 'message-templates', correlationId, by: staff.userId, id: data.id });
    return jsonResponse(req, { ok: true, template: data });
  }

  if (body.action === 'update') {
    if (!body.id) return jsonResponse(req, { error: 'id required' }, 400);
    const patch: Record<string, unknown> = {};
    if (body.name_he !== undefined) patch.name_he = body.name_he.trim();
    if (body.body !== undefined) patch.body = body.body;
    if (body.description !== undefined) patch.description = body.description?.trim() || null;
    if (body.variables_used !== undefined) patch.variables_used = body.variables_used;
    if (body.tags !== undefined) patch.tags = body.tags;
    if (body.status !== undefined) patch.status = body.status;
    if (body.notes !== undefined) patch.notes = body.notes?.trim() || null;
    if (body.subject !== undefined) patch.subject = body.subject?.trim() || null;
    if (body.body_html !== undefined) {
      patch.body_html = body.body_html ? sanitizeEmailHtml(body.body_html) : null;
    }
    if (Object.keys(patch).length === 0) {
      return jsonResponse(req, { error: 'no fields to update' }, 400);
    }
    const { data, error } = await supabase
      .from('message_templates').update(patch).eq('id', body.id).select('*').single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('template_updated', { fn: 'message-templates', correlationId, by: staff.userId, id: body.id });
    return jsonResponse(req, { ok: true, template: data });
  }

  return jsonResponse(req, { error: 'Unknown action' }, 400);
});
