// /reports — Tier 3 dashboards for commissions / presale / retention.
//
// Single endpoint returning all three sections in one round-trip.
// The frontend tabs flip between sections without re-fetching, which
// keeps the UI snappy when Mia compares "how's commissions vs
// presale this month?".
//
// GET → { ok, commissions: {...}, presale: {...}, retention: {...} }
//
// Each section reads from the 064 aggregate views — cheap.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'GET') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  try {
    await requireStaff(req, { allow: ['owner', 'admin', 'mia'] });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const supabase = getServiceSupabase();

  // Run the four reads in parallel — three section queries +
  // a sidebar of recent paid commissions. Total wall-clock is the
  // slowest one, not the sum.
  const [monthlyR, byPartnerR, atRiskR, stagesR] = await Promise.all([
    supabase.from('commission_monthly').select('*').order('month', { ascending: false }).limit(12),
    supabase.from('commission_by_partner').select('*').order('paid_total', { ascending: false }),
    supabase.from('presale_at_risk').select('*').order('risk_level').order('days_to_target'),
    supabase.from('retention_program_stages').select('*'),
  ]);

  const err = monthlyR.error ?? byPartnerR.error ?? atRiskR.error ?? stagesR.error;
  if (err) return jsonResponse(req, { error: err.message }, 500);

  return jsonResponse(req, {
    ok: true,
    commissions: {
      monthly: monthlyR.data ?? [],
      byPartner: byPartnerR.data ?? [],
    },
    presale: {
      atRisk: atRiskR.data ?? [],
    },
    retention: {
      stages: stagesR.data ?? [],
    },
  });
});
