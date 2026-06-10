// /automations — admin read-only view (for now) of the rule catalog
// and the most recent run log. Surfaces "what is running?" and "did
// it fire?" without anyone having to grep server logs.
//
// GET                       → list all rules
// GET ?runs=1               → list rules + last 50 runs per rule
// GET ?contact_id=...       → runs scoped to one contact (the lead
//                             detail page calls this to show "what
//                             did the automations do for this lead?")
// POST { action: 'toggle', id, enabled } → enable/disable a rule

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
    const includeRuns = url.searchParams.get('runs') === '1';
    const contactId = url.searchParams.get('contact_id');

    if (contactId) {
      // Per-contact view feeds the lead detail page's "what did
      // automations do here?" pane. Capped at 200 runs to keep the
      // response cheap.
      const { data, error } = await supabase
        .from('automation_runs')
        .select('*, rule:automation_rules(code, name_he, category)')
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) return jsonResponse(req, { error: error.message }, 500);
      return jsonResponse(req, { ok: true, runs: data ?? [] });
    }

    const { data: rules, error: rulesErr } = await supabase
      .from('automation_rules')
      .select('*')
      .order('category')
      .order('code');
    if (rulesErr) return jsonResponse(req, { error: rulesErr.message }, 500);

    if (!includeRuns) {
      return jsonResponse(req, { ok: true, rules: rules ?? [] });
    }

    // Pull the last 50 runs across all rules so the admin UI can show
    // a recent-history strip per rule. Cheap by created_at desc index.
    const { data: runs, error: runsErr } = await supabase
      .from('automation_runs')
      .select('id, rule_id, rule_code, trigger_event, contact_id, status, reason, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (runsErr) return jsonResponse(req, { error: runsErr.message }, 500);

    return jsonResponse(req, { ok: true, rules: rules ?? [], runs: runs ?? [] });
  }

  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const body = (await req.json().catch(() => ({}))) as {
    action?: string; id?: string; enabled?: boolean;
    conditions?: unknown; actions?: unknown;
  };

  if (body.action === 'toggle') {
    if (!body.id || typeof body.enabled !== 'boolean') {
      return jsonResponse(req, { error: 'id + enabled required' }, 400);
    }
    const { data, error } = await supabase
      .from('automation_rules')
      .update({ enabled: body.enabled })
      .eq('id', body.id)
      .select('*')
      .single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('automation_toggled', { fn: 'automations', correlationId, by: staff.userId, id: body.id, enabled: body.enabled });
    return jsonResponse(req, { ok: true, rule: data });
  }

  // Tier 4.A.4 — owner/admin can edit conditions+actions DSL inline.
  // Validation is structural only — engine handles unknown ops/types
  // gracefully (logs as skipped) so we don't enforce a strict schema
  // at the API layer.
  if (body.action === 'update_dsl') {
    if (!body.id) return jsonResponse(req, { error: 'id required' }, 400);
    if (body.conditions !== undefined && (typeof body.conditions !== 'object' || body.conditions === null)) {
      return jsonResponse(req, { error: 'conditions must be an object' }, 400);
    }
    if (body.actions !== undefined && !Array.isArray(body.actions)) {
      return jsonResponse(req, { error: 'actions must be an array' }, 400);
    }
    const patch: Record<string, unknown> = {};
    if (body.conditions !== undefined) patch.conditions = body.conditions;
    if (body.actions !== undefined) patch.actions = body.actions;
    if (Object.keys(patch).length === 0) return jsonResponse(req, { error: 'nothing to update' }, 400);

    const { data, error } = await supabase
      .from('automation_rules').update(patch).eq('id', body.id).select('*').single();
    if (error) return jsonResponse(req, { error: error.message }, 400);
    log.info('automation_dsl_updated', { fn: 'automations', correlationId, by: staff.userId, id: body.id });
    return jsonResponse(req, { ok: true, rule: data });
  }

  return jsonResponse(req, { error: 'Unknown action' }, 400);
});
