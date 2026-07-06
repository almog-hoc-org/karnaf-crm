// Program-member service — the single way a lead becomes a member of
// "הדרך לדירה". Every entry point (payment webhook, manual mark, bulk
// import, mark_won) goes through ensureProgramMember so provenance,
// the lead's track, and the audit event stay consistent.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { logLeadEvent } from './lead-service.ts';

export type MemberJoinedVia = 'payment' | 'won' | 'manual' | 'import';

export interface EnsureProgramMemberInput {
  leadId: string;
  joinedVia: MemberJoinedVia;
  actorType: string;
  actorId?: string;
  metadata?: Record<string, unknown>;
  correlationId?: string;
}

export interface EnsureProgramMemberResult {
  created: boolean;
}

export async function ensureProgramMember(
  supabase: SupabaseClient,
  input: EnsureProgramMemberInput,
): Promise<EnsureProgramMemberResult> {
  const { data: existing, error: readErr } = await supabase
    .from('program_members')
    .select('lead_id')
    .eq('lead_id', input.leadId)
    .maybeSingle();
  if (readErr) throw readErr;

  if (existing) {
    // Already a member — merge metadata only, never downgrade
    // progress_stage or overwrite joined_via.
    if (input.metadata && Object.keys(input.metadata).length > 0) {
      await supabase.from('program_members').update({
        metadata: input.metadata,
        updated_at: new Date().toISOString(),
      }).eq('lead_id', input.leadId);
    }
    return { created: false };
  }

  const { error: insertErr } = await supabase.from('program_members').insert({
    lead_id: input.leadId,
    progress_stage: 'joined',
    joined_via: input.joinedVia,
    metadata: input.metadata ?? {},
  });
  if (insertErr) {
    // 23505 = a concurrent caller created the row between our read and
    // insert. Same outcome as `existing` above.
    if ((insertErr as { code?: string }).code === '23505') return { created: false };
    throw insertErr;
  }

  // Fill-only: a member's home track is the program unless the lead
  // already has an explicit track (e.g. presale buyer who also joined).
  const { data: lead } = await supabase
    .from('leads')
    .select('primary_track')
    .eq('id', input.leadId)
    .maybeSingle();
  if (lead && !lead.primary_track) {
    await supabase.from('leads').update({ primary_track: 'program' }).eq('id', input.leadId);
  }

  await logLeadEvent(supabase, input.leadId, 'program_member_marked', input.actorType, {
    joined_via: input.joinedVia,
    correlation_id: input.correlationId ?? null,
  }, undefined, input.actorId);

  return { created: true };
}
