// Aggregated analytics for the dashboard / analytics view. Exposes the
// public.v_* views via a single round-trip so the frontend doesn't query
// the DB directly.

import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'GET') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  try { await requireStaff(req); } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const supabase = getServiceSupabase();
  const [sourcePerf, campaignPerf, aging, recentActivity, aiVsHuman, promptVariants, cohorts, firstResponseTimes] = await Promise.all([
    supabase.from('v_source_performance').select('*'),
    supabase.from('v_campaign_performance').select('*').order('leads_total', { ascending: false }).limit(100),
    supabase.from('v_lead_aging').select('lead_status, minutes_in_state').order('minutes_in_state', { ascending: false }).limit(500),
    supabase.from('v_recent_activity').select('*').limit(50),
    supabase.from('v_ai_vs_mia_outcomes').select('*'),
    supabase.from('v_prompt_variant_outcomes').select('*'),
    supabase.from('v_lead_cohorts').select('*').order('cohort_week', { ascending: false }).limit(60),
    supabase.from('v_first_response_times').select('*'),
  ]);

  if (sourcePerf.error) return jsonResponse(req, { error: sourcePerf.error.message }, 500);

  // Compress the aging set into status-bucketed averages for the UI.
  type AgeRow = { lead_status: string; minutes_in_state: number };
  const ageBuckets: Record<string, { count: number; totalMinutes: number; maxMinutes: number }> = {};
  for (const row of (aging.data ?? []) as AgeRow[]) {
    const status = row.lead_status;
    const minutes = Number(row.minutes_in_state ?? 0);
    const bucket = ageBuckets[status] ?? { count: 0, totalMinutes: 0, maxMinutes: 0 };
    bucket.count++;
    bucket.totalMinutes += minutes;
    bucket.maxMinutes = Math.max(bucket.maxMinutes, minutes);
    ageBuckets[status] = bucket;
  }
  const agingSummary = Object.fromEntries(
    Object.entries(ageBuckets).map(([k, v]) => [k, {
      count: v.count,
      avgMinutes: v.count ? Math.round(v.totalMinutes / v.count) : 0,
      maxMinutes: v.maxMinutes,
    }]),
  );

  return jsonResponse(req, {
    ok: true,
    sourcePerformance: sourcePerf.data ?? [],
    campaignPerformance: campaignPerf.data ?? [],
    aging: agingSummary,
    recentActivity: recentActivity.data ?? [],
    aiVsHuman: aiVsHuman.data ?? [],
    promptVariants: promptVariants.data ?? [],
    cohorts: cohorts.data ?? [],
    firstResponseTimes: firstResponseTimes.data ?? [],
  });
});
