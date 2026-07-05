// Broadcasts CRUD + lifecycle endpoint. Staff-gated (owner/admin/mia).
//
//   GET  /broadcasts            → list recent broadcasts
//   GET  /broadcasts?id=<uuid>  → one broadcast + live recipient stats
//   POST /broadcasts { action } → create | update | schedule | cancel
//                                 | preview_count | stats
//
// The worker (broadcast-dispatch) does the actual sending; this function
// only manages broadcast definitions and reports analytics.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { countSegment, type BroadcastSegment } from '../_shared/broadcast-segment.ts';

const STAFF = ['owner', 'admin', 'mia'] as const;

interface CreatePayload {
  action: 'create';
  name: string;
  channel?: 'whatsapp' | 'email';
  template_key?: string | null;
  meta_template?: Record<string, unknown> | null;
  body_snapshot?: string | null;
  segment?: BroadcastSegment;
  scheduled_at?: string | null;
}
interface UpdatePayload {
  action: 'update';
  id: string;
  name?: string;
  template_key?: string | null;
  meta_template?: Record<string, unknown> | null;
  body_snapshot?: string | null;
  segment?: BroadcastSegment;
  scheduled_at?: string | null;
}
interface IdPayload { action: 'schedule' | 'cancel' | 'stats'; id: string; scheduled_at?: string | null }
interface PreviewPayload { action: 'preview_count'; segment: BroadcastSegment; channel?: 'whatsapp' | 'email' }
type Payload = CreatePayload | UpdatePayload | IdPayload | PreviewPayload;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const correlationId = correlationFromRequest(req);

  try {
    await requireStaff(req, { allow: [...STAFF] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const supabase = getServiceSupabase();

  if (req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('id');
    if (id) return await getOne(req, supabase, id);
    return await list(req, supabase);
  }

  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  let body: Payload;
  try {
    body = (await req.json()) as Payload;
  } catch {
    return jsonResponse(req, { error: 'Invalid JSON' }, 400);
  }

  try {
    switch (body.action) {
      case 'create': return await create(req, supabase, body);
      case 'update': return await update(req, supabase, body);
      case 'schedule': return await schedule(req, supabase, body, correlationId);
      case 'cancel': return await cancel(req, supabase, body);
      case 'preview_count': return await previewCount(req, supabase, body);
      case 'stats': return await stats(req, supabase, body.id);
      default: return jsonResponse(req, { error: 'Unknown action' }, 400);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('broadcasts_action_failed', { fn: 'broadcasts', correlationId, action: body.action, err: msg });
    return jsonResponse(req, { error: msg }, 500);
  }
});

async function list(req: Request, supabase: ReturnType<typeof getServiceSupabase>) {
  const { data, error } = await supabase
    .from('broadcasts')
    .select('id, name, channel, template_key, meta_template, body_snapshot, segment, scheduled_at, status, recipient_count, sent_count, skipped_count, failed_count, created_at, updated_at, sent_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return jsonResponse(req, { error: error.message }, 500);
  return jsonResponse(req, { ok: true, broadcasts: data ?? [] });
}

async function getOne(req: Request, supabase: ReturnType<typeof getServiceSupabase>, id: string) {
  const { data, error } = await supabase.from('broadcasts').select('*').eq('id', id).maybeSingle();
  if (error) return jsonResponse(req, { error: error.message }, 500);
  if (!data) return jsonResponse(req, { error: 'Not found' }, 404);
  const s = await computeStats(supabase, id);
  return jsonResponse(req, { ok: true, broadcast: data, stats: s });
}

async function create(req: Request, supabase: ReturnType<typeof getServiceSupabase>, body: CreatePayload) {
  if (!body.name?.trim()) return jsonResponse(req, { error: 'name required' }, 400);
  const channel = body.channel ?? 'whatsapp';
  if (channel === 'whatsapp' && !body.meta_template?.name) {
    return jsonResponse(req, { error: 'meta_template.name required for whatsapp broadcasts' }, 400);
  }
  const staff = await requireStaff(req, { allow: [...STAFF] });
  const { data, error } = await supabase.from('broadcasts').insert({
    name: body.name.trim(),
    channel,
    template_key: body.template_key ?? null,
    meta_template: body.meta_template ?? null,
    body_snapshot: body.body_snapshot ?? null,
    segment: body.segment ?? {},
    scheduled_at: body.scheduled_at ?? null,
    status: 'draft',
    created_by: staff.userId,
  }).select('*').single();
  if (error) return jsonResponse(req, { error: error.message }, 500);
  return jsonResponse(req, { ok: true, broadcast: data });
}

async function update(req: Request, supabase: ReturnType<typeof getServiceSupabase>, body: UpdatePayload) {
  const { data: existing } = await supabase.from('broadcasts').select('status').eq('id', body.id).maybeSingle();
  if (!existing) return jsonResponse(req, { error: 'Not found' }, 404);
  if (!['draft', 'scheduled'].includes(existing.status as string)) {
    return jsonResponse(req, { error: `cannot edit a ${existing.status} broadcast` }, 409);
  }
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.template_key !== undefined) patch.template_key = body.template_key;
  if (body.meta_template !== undefined) patch.meta_template = body.meta_template;
  if (body.body_snapshot !== undefined) patch.body_snapshot = body.body_snapshot;
  if (body.segment !== undefined) patch.segment = body.segment;
  if (body.scheduled_at !== undefined) patch.scheduled_at = body.scheduled_at;
  const { data, error } = await supabase.from('broadcasts').update(patch).eq('id', body.id).select('*').single();
  if (error) return jsonResponse(req, { error: error.message }, 500);
  return jsonResponse(req, { ok: true, broadcast: data });
}

async function schedule(
  req: Request,
  supabase: ReturnType<typeof getServiceSupabase>,
  body: IdPayload,
  correlationId: string,
) {
  const { data: b, error: bErr } = await supabase
    .from('broadcasts').select('*').eq('id', body.id).maybeSingle();
  if (bErr) return jsonResponse(req, { error: bErr.message }, 500);
  if (!b) return jsonResponse(req, { error: 'Not found' }, 404);
  if (!['draft', 'scheduled'].includes(b.status as string)) {
    return jsonResponse(req, { error: `cannot schedule a ${b.status} broadcast` }, 409);
  }
  if (b.channel === 'whatsapp' && !(b.meta_template as { name?: string } | null)?.name) {
    return jsonResponse(req, { error: 'meta_template.name required before scheduling' }, 400);
  }

  const recipientCount = await countSegment(supabase, (b.segment ?? {}) as BroadcastSegment, b.channel === 'whatsapp');
  const scheduledAt = body.scheduled_at ?? new Date().toISOString();

  const { data, error } = await supabase.from('broadcasts').update({
    status: 'scheduled',
    scheduled_at: scheduledAt,
    recipient_count: recipientCount,
  }).eq('id', body.id).select('*').single();
  if (error) return jsonResponse(req, { error: error.message }, 500);
  log.info('broadcast_scheduled', { fn: 'broadcasts', correlationId, broadcastId: body.id, recipientCount, scheduledAt });
  return jsonResponse(req, { ok: true, broadcast: data, recipient_count: recipientCount });
}

async function cancel(req: Request, supabase: ReturnType<typeof getServiceSupabase>, body: IdPayload) {
  const { data: b } = await supabase.from('broadcasts').select('status').eq('id', body.id).maybeSingle();
  if (!b) return jsonResponse(req, { error: 'Not found' }, 404);
  if (['sent', 'canceled'].includes(b.status as string)) {
    return jsonResponse(req, { error: `broadcast already ${b.status}` }, 409);
  }
  const { data, error } = await supabase.from('broadcasts')
    .update({ status: 'canceled' }).eq('id', body.id).select('*').single();
  if (error) return jsonResponse(req, { error: error.message }, 500);
  return jsonResponse(req, { ok: true, broadcast: data });
}

async function previewCount(req: Request, supabase: ReturnType<typeof getServiceSupabase>, body: PreviewPayload) {
  const count = await countSegment(supabase, body.segment ?? {}, (body.channel ?? 'whatsapp') === 'whatsapp');
  return jsonResponse(req, { ok: true, count });
}

async function stats(req: Request, supabase: ReturnType<typeof getServiceSupabase>, id: string) {
  const s = await computeStats(supabase, id);
  return jsonResponse(req, { ok: true, stats: s });
}

interface BroadcastStats {
  total: number;
  pending: number;
  queued: number;
  sent: number;
  skipped: number;
  failed: number;
  delivered: number;
  read: number;
}

// Live analytics from broadcast_recipients, embedding message status so
// delivered/read (updated by provider-status-webhook) roll up here.
async function computeStats(supabase: ReturnType<typeof getServiceSupabase>, id: string): Promise<BroadcastStats> {
  const s: BroadcastStats = { total: 0, pending: 0, queued: 0, sent: 0, skipped: 0, failed: 0, delivered: 0, read: 0 };
  const { data, error } = await supabase
    .from('broadcast_recipients')
    .select('status, message:messages(provider_status)')
    .eq('broadcast_id', id)
    .limit(20_000);
  if (error) throw new Error(error.message);
  for (const r of (data ?? []) as unknown as Array<{ status: string; message: { provider_status: string | null } | null }>) {
    s.total += 1;
    if (r.status in s) (s as unknown as Record<string, number>)[r.status] += 1;
    const ps = r.message?.provider_status;
    if (ps === 'delivered' || ps === 'read') s.delivered += 1;
    if (ps === 'read') s.read += 1;
  }
  return s;
}
