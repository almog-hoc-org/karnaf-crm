import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendTemplateAction, type EngineContext } from './journey-actions.ts';
import type { LeadRow } from './lead-service.ts';

interface StudentState {
  lead_id: string;
  last_checkin_at: string | null;
  checkin_count: number;
}

function isDue(state: StudentState | null, lead: LeadRow, now: number): boolean {
  const baseline = state?.last_checkin_at
    ?? (lead.payment_completed_at as string | null)
    ?? (lead.won_at as string | null)
    ?? (lead.created_at as string | null);
  if (!baseline) return false;
  return now - new Date(baseline).getTime() >= 14 * 24 * 3600 * 1000;
}

export async function runBiweeklyStudentCheckins(
  supabase: SupabaseClient,
  correlationId: string,
  limit = 50,
): Promise<{ considered: number; sent: number; skipped: number; failed: number }> {
  const { data: leads, error } = await supabase
    .from('leads')
    .select('*')
    .eq('payment_status', 'paid')
    .eq('do_not_contact', false)
    .eq('removed_by_request', false)
    .not('phone', 'is', null)
    .order('payment_completed_at', { ascending: true, nullsFirst: false })
    .limit(limit);
  if (error) throw error;

  const counters = { considered: 0, sent: 0, skipped: 0, failed: 0 };
  const now = Date.now();
  for (const lead of (leads ?? []) as LeadRow[]) {
    counters.considered++;
    const { data: state, error: stateErr } = await supabase
      .from('student_lifecycle_state')
      .select('lead_id, last_checkin_at, checkin_count')
      .eq('lead_id', lead.id)
      .maybeSingle();
    if (stateErr) {
      counters.failed++;
      continue;
    }

    if (!isDue(state as StudentState | null, lead, now)) {
      counters.skipped++;
      continue;
    }

    const ctx: EngineContext = {
      lead,
      triggerEvent: 'student.biweekly_checkin',
      correlationId,
      data: {
        checkin_count: Number((state as StudentState | null)?.checkin_count ?? 0) + 1,
      },
    };
    const result = await sendTemplateAction(supabase, {
      type: 'send_template',
      key: 'karnaf_student_checkin_14d_v1',
      channel: 'whatsapp',
      once: false,
    }, ctx);

    await supabase.from('automation_runs').insert({
      rule_code: 'lifecycle_student_biweekly_checkin',
      trigger_event: 'student.biweekly_checkin',
      contact_id: lead.id,
      context: { lead_id: lead.id, correlation_id: correlationId },
      action_results: [result],
      status: result.status === 'success' ? 'success' : result.status,
      reason: result.reason ?? null,
      correlation_id: correlationId,
    });

    if (result.status === 'success') {
      await supabase.from('student_lifecycle_state').upsert({
        lead_id: lead.id,
        last_checkin_at: new Date().toISOString(),
        checkin_count: Number((state as StudentState | null)?.checkin_count ?? 0) + 1,
      }, { onConflict: 'lead_id' });
      counters.sent++;
    } else if (result.status === 'skipped') {
      counters.skipped++;
    } else {
      counters.failed++;
    }
  }
  return counters;
}
