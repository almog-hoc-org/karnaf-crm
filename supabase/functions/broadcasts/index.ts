// CRUD + lifecycle for the broadcast module (הודעות תפוצה). Owner/admin/mia.
//
// GET  ?id=<id>       → one broadcast + per-status recipient stats
// GET                 → list broadcasts (newest first)
// POST { action: ... }
//   create        → new draft
//   update        → patch a draft
//   delete        → remove a draft/cancelled broadcast
//   schedule      → draft → scheduled (requires scheduled_at + a body)
//   cancel        → scheduled/sending → cancelled
//   preview_count → count + sample of leads matching a segment (no write)

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';
import { countSegment, fetchSegmentLeads, type BroadcastSegment } from '../_shared/broadcast-segment.ts';
import { resolvePacing } from '../_shared/broadcast-pacing.ts';

interface MetaTemplate { name: string; lang?: string; params?: string[] }

async function bodyForTemplate(
  supabase: ReturnType<typeof getServiceSupabase>,
  templateKey: string | null | undefined,
  channel: string,
): Promise<string | null> {
  if (!templateKey) return null;
  const { data } = await supabase
    .from('message_templates')
    .select('body')
    .eq('key', templateKey)
    .eq('channel', channel)
    .maybeSingle();
  return (data?.body as string | undefined) ?? null;
}

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
    const id = url.searchParams.get('id');
    if (id) {
      const { data: broadcast, error } = await supabase
        .from('broadcasts').select('*').eq('id', id).maybeSingle();
      if (error) return jsonResponse(req, { error: error.message }, 500);
      if (!broadcast) return jsonResponse(req, { error: 'not found' }, 404);
      const stats = await recipientStats(supabase, id);
      return jsonResponse(req, { ok: true, broadcast, stats });
    }
    const { data, error } = await supabase
      .from('broadcasts').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) return jsonResponse(req, { error: error.message }, 500);
    // Expose the live pacing knobs so the UI can show real numbers
    // instead of hardcoded ones.
    const { data: pacingRow } = await supabase
      .from('crm_config').select('config_value').eq('config_key', 'broadcast_pacing').maybeSingle();
    const pacing = resolvePacing(pacingRow?.config_value);
    return jsonResponse(req, { ok: true, broadcasts: data ?? [], pacing });
  }

  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action as string | undefined;

  if (action === 'preview_count') {
    const segment = (body.segment ?? {}) as BroadcastSegment;
    try {
      const count = await countSegment(supabase, segment);
      const sample = await fetchSegmentLeads(supabase, segment, 5);
      return jsonResponse(req, { ok: true, count, sample });
    } catch (err) {
      return jsonResponse(req, { error: err instanceof Error ? err.message : String(err) }, 400);
    }
  }

  if (action === 'create') {
    const name = (body.name as string | undefined)?.trim();
    if (!name) return jsonResponse(req, { error: 'name required' }, 400);
    const channel = (body.channel as string | undefined) ?? 'whatsapp';
    if (channel === 'email') return jsonResponse(req, { error: 'email channel not yet available' }, 400);
    const templateKey = (body.template_key as string | undefined) ?? null;
    const bodySnapshot = await bodyForTemplate(supabase, templateKey, channel);
    const { data, error } = await supabase.from('broadcasts').insert({
      name,
      channel,
      template_key: templateKey,
      meta_template: (body.meta_template as MetaTemplate | undefined) ?? null,
      body_snapshot: bodySnapshot,
      segment: (body.segment as BroadcastSegment | undefined) ?? {},
      scheduled_at: (body.scheduled_at as string | undefined) ?? null,
      created_by: staff.userId,
    }).select('*').single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('broadcast_created', { fn: 'broadcasts', correlationId, by: staff.userId, id: data.id });
    return jsonResponse(req, { ok: true, broadcast: data });
  }

  if (action === 'update') {
    const id = body.id as string | undefined;
    if (!id) return jsonResponse(req, { error: 'id required' }, 400);
    const { data: existing } = await supabase.from('broadcasts').select('status, channel').eq('id', id).maybeSingle();
    if (!existing) return jsonResponse(req, { error: 'not found' }, 404);
    if (existing.status !== 'draft') return jsonResponse(req, { error: 'only draft broadcasts can be edited' }, 409);
    const channel = (body.channel as string | undefined) ?? existing.channel;
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = (body.name as string).trim();
    if (body.channel !== undefined) patch.channel = channel;
    if (body.segment !== undefined) patch.segment = body.segment;
    if (body.scheduled_at !== undefined) patch.scheduled_at = body.scheduled_at;
    if (body.meta_template !== undefined) patch.meta_template = body.meta_template;
    if (body.template_key !== undefined) {
      patch.template_key = body.template_key;
      patch.body_snapshot = await bodyForTemplate(supabase, body.template_key as string, channel);
    }
    if (Object.keys(patch).length === 0) return jsonResponse(req, { error: 'no fields to update' }, 400);
    const { data, error } = await supabase.from('broadcasts').update(patch).eq('id', id).select('*').single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    return jsonResponse(req, { ok: true, broadcast: data });
  }

  if (action === 'schedule') {
    const id = body.id as string | undefined;
    if (!id) return jsonResponse(req, { error: 'id required' }, 400);
    const { data: b } = await supabase
      .from('broadcasts').select('*').eq('id', id).maybeSingle();
    if (!b) return jsonResponse(req, { error: 'not found' }, 404);
    if (b.status !== 'draft') return jsonResponse(req, { error: `cannot schedule a ${b.status} broadcast` }, 409);
    if (!b.scheduled_at) return jsonResponse(req, { error: 'scheduled_at required before scheduling' }, 400);
    if (b.channel === 'whatsapp' && !(b.meta_template as MetaTemplate | null)?.name) {
      return jsonResponse(req, { error: 'WhatsApp broadcasts require an approved Meta template (meta_template.name)' }, 400);
    }
    // Snapshot the current segment size for display; recipients are
    // materialised at send time by the worker.
    const count = await countSegment(supabase, (b.segment ?? {}) as BroadcastSegment);
    const { data, error } = await supabase
      .from('broadcasts')
      .update({ status: 'scheduled', recipients_count: count })
      .eq('id', id).select('*').single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('broadcast_scheduled', { fn: 'broadcasts', correlationId, id, count });
    return jsonResponse(req, { ok: true, broadcast: data });
  }

  if (action === 'cancel') {
    const id = body.id as string | undefined;
    if (!id) return jsonResponse(req, { error: 'id required' }, 400);
    const { data, error } = await supabase
      .from('broadcasts')
      .update({ status: 'cancelled' })
      .eq('id', id).in('status', ['scheduled', 'sending']).select('*').maybeSingle();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    if (!data) return jsonResponse(req, { error: 'not found or not cancellable' }, 409);
    return jsonResponse(req, { ok: true, broadcast: data });
  }

  if (action === 'delete') {
    const id = body.id as string | undefined;
    if (!id) return jsonResponse(req, { error: 'id required' }, 400);
    const { error } = await supabase
      .from('broadcasts').delete().eq('id', id).in('status', ['draft', 'cancelled', 'failed']);
    if (error) return jsonResponse(req, { error: error.message }, 400);
    return jsonResponse(req, { ok: true });
  }

  return jsonResponse(req, { error: 'Unknown action' }, 400);
});

// Aggregate recipient outcomes + delivery/read from the linked messages.
async function recipientStats(
  supabase: ReturnType<typeof getServiceSupabase>,
  broadcastId: string,
) {
  const { data } = await supabase
    .from('broadcast_recipients')
    .select('status, sent_at, messages(delivered_at, read_at, provider_status)')
    .eq('broadcast_id', broadcastId);
  const rows = (data ?? []) as unknown as Array<{
    status: string;
    messages: { delivered_at: string | null; read_at: string | null; provider_status: string | null } | null;
  }>;
  const stats = {
    total: rows.length,
    pending: 0, enqueued: 0, sent: 0, failed: 0, skipped: 0,
    delivered: 0, read: 0,
  };
  for (const r of rows) {
    if (r.status in stats) (stats as Record<string, number>)[r.status] += 1;
    if (r.messages?.delivered_at) stats.delivered += 1;
    if (r.messages?.read_at) stats.read += 1;
  }
  return stats;
}
