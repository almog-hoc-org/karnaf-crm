// CRUD for WhatsApp router topic options. Owner/admin only.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

type Track = 'program' | 'presale' | 'investor_mentorship' | 'human';

type Payload =
  | { action: 'create'; option_key: string; display_order?: number; label_he: string; match_terms?: string[]; track: Track; stage?: string | null; interest_topic?: string | null; presale_project?: string | null; is_active?: boolean }
  | { action: 'update'; option_key: string; display_order?: number; label_he?: string; match_terms?: string[]; track?: Track; stage?: string | null; interest_topic?: string | null; presale_project?: string | null; is_active?: boolean }
  | { action: 'delete'; option_key: string };

const OPTION_KEY_RE = /^[a-z][a-z0-9_]{1,59}$/;
const TRACKS = new Set<Track>(['program', 'presale', 'investor_mentorship', 'human']);

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
    const url = new URL(req.url);
    if (url.searchParams.get('audit') === '1') {
      const limit = clampNumber(Number(url.searchParams.get('limit') ?? 50), 1, 200);
      const { data, error } = await supabase
        .from('whatsapp_router_option_events')
        .select('id, option_key, action, actor_user_id, before_value, after_value, changed_fields, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) return jsonResponse(req, { error: error.message }, 500);
      return jsonResponse(req, { ok: true, events: data ?? [] });
    }

    const { data, error } = await supabase
      .from('whatsapp_router_options')
      .select('option_key, display_order, label_he, match_terms, track, stage, interest_topic, presale_project, is_active, updated_at')
      .order('display_order', { ascending: true })
      .order('option_key', { ascending: true });
    if (error) return jsonResponse(req, { error: error.message }, 500);
    return jsonResponse(req, { ok: true, options: data ?? [] });
  }

  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const body = (await req.json().catch(() => ({}))) as Payload;
  if (!body.action) return jsonResponse(req, { error: 'Missing action' }, 400);

  if (body.action === 'delete') {
    if (!body.option_key) return jsonResponse(req, { error: 'option_key required' }, 400);
    const before = await fetchOption(supabase, body.option_key);
    const { error } = await supabase.from('whatsapp_router_options').delete().eq('option_key', body.option_key);
    if (error) return jsonResponse(req, { error: error.message }, 400);
    await logRouterOptionEvent(supabase, {
      optionKey: body.option_key,
      action: 'delete',
      actorUserId: staff.userId,
      beforeValue: before,
      afterValue: null,
      changedFields: before ? Object.keys(before) : [],
    });
    log.info('whatsapp_router_option_deleted', { fn: 'whatsapp-router-options', correlationId, by: staff.userId, optionKey: body.option_key });
    return jsonResponse(req, { ok: true });
  }

  const validationError = validatePayload(body);
  if (validationError) return jsonResponse(req, { error: validationError }, 400);

  if (body.action === 'create') {
    const { data, error } = await supabase
      .from('whatsapp_router_options')
      .insert(cleanOptionPatch(body, true))
      .select('option_key, display_order, label_he, match_terms, track, stage, interest_topic, presale_project, is_active, updated_at')
      .single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    await logRouterOptionEvent(supabase, {
      optionKey: body.option_key,
      action: 'create',
      actorUserId: staff.userId,
      beforeValue: null,
      afterValue: data,
      changedFields: Object.keys(data ?? {}),
    });
    log.info('whatsapp_router_option_created', { fn: 'whatsapp-router-options', correlationId, by: staff.userId, optionKey: body.option_key });
    return jsonResponse(req, { ok: true, option: data });
  }

  const patch = cleanOptionPatch(body, false);
  if (Object.keys(patch).length === 0) return jsonResponse(req, { error: 'no fields to update' }, 400);
  const before = await fetchOption(supabase, body.option_key);
  const { data, error } = await supabase
    .from('whatsapp_router_options')
    .update(patch)
    .eq('option_key', body.option_key)
    .select('option_key, display_order, label_he, match_terms, track, stage, interest_topic, presale_project, is_active, updated_at')
    .single();
  if (error) return jsonResponse(req, { error: error.message }, 400);
  await logRouterOptionEvent(supabase, {
    optionKey: body.option_key,
    action: 'update',
    actorUserId: staff.userId,
    beforeValue: before,
    afterValue: data,
    changedFields: changedFields(before, data),
  });
  log.info('whatsapp_router_option_updated', { fn: 'whatsapp-router-options', correlationId, by: staff.userId, optionKey: body.option_key });
  return jsonResponse(req, { ok: true, option: data });
});

async function fetchOption(supabase: ReturnType<typeof getServiceSupabase>, optionKey: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from('whatsapp_router_options')
    .select('option_key, display_order, label_he, match_terms, track, stage, interest_topic, presale_project, is_active, updated_at')
    .eq('option_key', optionKey)
    .maybeSingle();
  if (error) return null;
  return data ?? null;
}

async function logRouterOptionEvent(
  supabase: ReturnType<typeof getServiceSupabase>,
  input: {
    optionKey: string;
    action: 'create' | 'update' | 'delete';
    actorUserId: string;
    beforeValue: Record<string, unknown> | null;
    afterValue: Record<string, unknown> | null;
    changedFields: string[];
  },
) {
  const { error } = await supabase.from('whatsapp_router_option_events').insert({
    option_key: input.optionKey,
    action: input.action,
    actor_user_id: input.actorUserId,
    before_value: input.beforeValue,
    after_value: input.afterValue,
    changed_fields: input.changedFields,
  });
  if (error) {
    log.warn('whatsapp_router_option_audit_insert_failed', {
      fn: 'whatsapp-router-options',
      optionKey: input.optionKey,
      action: input.action,
      error: error.message,
    });
  }
}

function changedFields(beforeValue: Record<string, unknown> | null, afterValue: Record<string, unknown> | null): string[] {
  const keys = new Set([...Object.keys(beforeValue ?? {}), ...Object.keys(afterValue ?? {})]);
  return [...keys].filter((key) => JSON.stringify(beforeValue?.[key] ?? null) !== JSON.stringify(afterValue?.[key] ?? null));
}

function validatePayload(body: Payload): string | null {
  if (!body.option_key || !OPTION_KEY_RE.test(body.option_key)) return 'option_key must be lowercase a-z0-9_ (2-60 chars, leading letter)';
  if (body.action === 'create' && (!body.label_he || body.label_he.trim().length === 0)) return 'label_he required';
  if ('label_he' in body && body.label_he !== undefined && body.label_he.trim().length === 0) return 'label_he cannot be blank';
  if ('track' in body && body.track !== undefined && !TRACKS.has(body.track)) return 'unsupported track';
  if (body.action === 'create' && !body.track) return 'track required';
  if ('match_terms' in body && body.match_terms !== undefined) {
    if (!Array.isArray(body.match_terms)) return 'match_terms must be an array';
    if (!body.match_terms.some((term) => typeof term === 'string' && term.trim().length > 0)) return 'at least one match term required';
  }
  return null;
}

function cleanOptionPatch(body: Extract<Payload, { action: 'create' | 'update' }>, includeKey: boolean): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (includeKey) patch.option_key = body.option_key;
  if (body.display_order !== undefined) patch.display_order = clampNumber(body.display_order, 0, 9999);
  if (body.label_he !== undefined) patch.label_he = body.label_he.trim().slice(0, 120);
  if (body.match_terms !== undefined) patch.match_terms = normaliseTerms(body.match_terms);
  if (body.track !== undefined) patch.track = body.track;
  if (body.stage !== undefined) patch.stage = cleanNullableText(body.stage, 80);
  if (body.interest_topic !== undefined) patch.interest_topic = cleanNullableText(body.interest_topic, 180);
  if (body.presale_project !== undefined) patch.presale_project = cleanNullableText(body.presale_project, 180);
  if (body.is_active !== undefined) patch.is_active = body.is_active;
  return patch;
}

function normaliseTerms(terms: string[]): string[] {
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean).map((term) => term.slice(0, 80)))].slice(0, 20);
}

function cleanNullableText(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
