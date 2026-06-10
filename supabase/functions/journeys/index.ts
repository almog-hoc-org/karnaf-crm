// /journeys — Tier 4.B admin endpoint for journey definitions + runs.
//
// GET                       → list definitions + run counts per status
// GET ?runs=1               → also includes the 100 most recent active runs
// GET ?contact_id=X         → runs scoped to one contact
// POST {action:'cancel_run', id, reason} → cancel an active run
// POST {action:'update_def', id, ...patch} → edit a definition

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';
import { correlationFromRequest, log } from '../_shared/logger.ts';

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
    const contactId = url.searchParams.get('contact_id');
    if (contactId) {
      const { data, error } = await supabase
        .from('journey_runs')
        .select('*, definition:journey_definitions(code, name_he)')
        .eq('contact_id', contactId)
        .order('started_at', { ascending: false })
        .limit(50);
      if (error) return jsonResponse(req, { error: error.message }, 500);
      return jsonResponse(req, { ok: true, runs: data ?? [] });
    }

    const { data: defs, error: defErr } = await supabase
      .from('journey_definitions')
      .select('*')
      .order('code');
    if (defErr) return jsonResponse(req, { error: defErr.message }, 500);

    // Run counts per definition + status, computed in JS from a cheap
    // status-only query (small cardinality — these tables are
    // per-contact-per-journey).
    const { data: countsRaw, error: ctErr } = await supabase
      .from('journey_runs')
      .select('definition_id, status');
    if (ctErr) return jsonResponse(req, { error: ctErr.message }, 500);

    const counts: Record<string, Record<string, number>> = {};
    for (const r of countsRaw ?? []) {
      const map = counts[r.definition_id] ?? (counts[r.definition_id] = {});
      map[r.status] = (map[r.status] ?? 0) + 1;
    }

    const includeRuns = url.searchParams.get('runs') === '1';
    let runs: unknown[] = [];
    if (includeRuns) {
      const { data: r, error: rErr } = await supabase
        .from('journey_runs')
        .select('id, definition_id, definition_code, contact_id, current_step, scheduled_next_at, status, started_at, completed_at, last_error')
        .order('scheduled_next_at', { ascending: false })
        .limit(100);
      if (rErr) return jsonResponse(req, { error: rErr.message }, 500);
      runs = r ?? [];
    }

    return jsonResponse(req, { ok: true, definitions: defs ?? [], counts, runs });
  }

  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const body = (await req.json().catch(() => ({}))) as {
    action?: string; id?: string; reason?: string;
    steps?: unknown; trigger_conditions?: unknown;
    enabled?: boolean; name_he?: string; description?: string;
    allow_concurrent?: boolean;
  };

  if (body.action === 'cancel_run') {
    if (!body.id) return jsonResponse(req, { error: 'id required' }, 400);
    const { data, error } = await supabase
      .from('journey_runs')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancellation_reason: body.reason ?? 'admin cancelled',
      })
      .eq('id', body.id)
      .eq('status', 'active')
      .select('*')
      .maybeSingle();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    if (!data) return jsonResponse(req, { error: 'run not active or not found' }, 404);
    log.info('journey_run_cancelled', { fn: 'journeys', correlationId, by: staff.userId, id: body.id });
    return jsonResponse(req, { ok: true, run: data });
  }

  if (body.action === 'update_def') {
    if (!body.id) return jsonResponse(req, { error: 'id required' }, 400);
    const patch: Record<string, unknown> = {};
    if (body.name_he !== undefined) patch.name_he = body.name_he;
    if (body.description !== undefined) patch.description = body.description;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.allow_concurrent !== undefined) patch.allow_concurrent = body.allow_concurrent;
    if (body.trigger_conditions !== undefined) {
      if (typeof body.trigger_conditions !== 'object' || body.trigger_conditions === null) {
        return jsonResponse(req, { error: 'trigger_conditions must be object' }, 400);
      }
      patch.trigger_conditions = body.trigger_conditions;
    }
    if (body.steps !== undefined) {
      if (!Array.isArray(body.steps)) return jsonResponse(req, { error: 'steps must be array' }, 400);
      patch.steps = body.steps;
    }
    if (Object.keys(patch).length === 0) return jsonResponse(req, { error: 'nothing to update' }, 400);
    const { data, error } = await supabase
      .from('journey_definitions').update(patch).eq('id', body.id).select('*').single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('journey_def_updated', { fn: 'journeys', correlationId, by: staff.userId, id: body.id });
    return jsonResponse(req, { ok: true, definition: data });
  }

  return jsonResponse(req, { error: 'Unknown action' }, 400);
});
