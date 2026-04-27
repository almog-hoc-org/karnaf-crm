import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface QueueInput {
  leadId: string;
  queueType: string;
  priorityLevel: number;
  reason: string;
  queueSummary?: string | null;
  dueAt?: string | null;
  payloadJson?: Record<string, unknown>;
}

export async function ensurePendingQueueItem(supabase: SupabaseClient, input: QueueInput) {
  const { data: existing, error: existingError } = await supabase
    .from('work_queue')
    .select('id, status')
    .eq('lead_id', input.leadId)
    .eq('queue_type', input.queueType)
    .eq('status', 'pending')
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing) return existing;

  const { data: created, error: createdError } = await supabase
    .from('work_queue')
    .insert({
      lead_id: input.leadId,
      queue_type: input.queueType,
      priority_level: input.priorityLevel,
      status: 'pending',
      reason: input.reason,
      queue_summary: input.queueSummary || null,
      created_by_actor_type: 'system',
      due_at: input.dueAt || null,
      payload_json: input.payloadJson || {},
    })
    .select('id, status')
    .single();

  if (createdError) throw createdError;
  return created;
}
