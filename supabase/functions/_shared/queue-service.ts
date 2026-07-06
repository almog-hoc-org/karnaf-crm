import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface QueueItemInput {
  leadId: string;
  queueType: string;
  priorityLevel: number;
  reason: string;
  queueSummary?: string | null;
  dueAt?: string | null;
  payloadJson?: Record<string, unknown>;
  createdByActorType?: string;
}

export async function ensurePendingQueueItem(supabase: SupabaseClient, input: QueueItemInput) {
  const { data: existing, error: existingErr } = await supabase
    .from('work_queue')
    .select('id, status')
    .eq('lead_id', input.leadId)
    .eq('queue_type', input.queueType)
    .eq('status', 'pending')
    .maybeSingle();
  if (existingErr) throw existingErr;
  if (existing) return { ...existing, created: false };

  const { data: created, error: createdErr } = await supabase
    .from('work_queue')
    .insert({
      lead_id: input.leadId,
      queue_type: input.queueType,
      priority_level: input.priorityLevel,
      status: 'pending',
      reason: input.reason,
      queue_summary: input.queueSummary ?? null,
      created_by_actor_type: input.createdByActorType ?? 'system',
      due_at: input.dueAt ?? null,
      payload_json: input.payloadJson ?? {},
    })
    .select('id, status')
    .single();
  if (createdErr) throw createdErr;
  return { ...created, created: true };
}

export async function resolveQueueItem(
  supabase: SupabaseClient,
  itemId: string,
  resolutionNote: string | null,
) {
  const { error } = await supabase
    .from('work_queue')
    .update({ status: 'resolved', resolved_at: new Date().toISOString(), resolution_note: resolutionNote })
    .eq('id', itemId);
  if (error) throw error;
}
