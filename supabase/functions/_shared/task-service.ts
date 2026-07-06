import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface CreateTaskInput {
  leadId: string;
  conversationId?: string;
  taskType: string;
  ownerType: string;
  title: string;
  description?: string | null;
  priorityLevel?: number;
  dueAt?: string | null;
  payloadJson?: Record<string, unknown>;
}

export async function createLeadTask(supabase: SupabaseClient, input: CreateTaskInput) {
  const { data, error } = await supabase
    .from('lead_tasks')
    .insert({
      lead_id: input.leadId,
      conversation_id: input.conversationId || null,
      task_type: input.taskType,
      task_status: 'open',
      owner_type: input.ownerType,
      title: input.title,
      description: input.description || null,
      priority_level: input.priorityLevel || 3,
      due_at: input.dueAt || null,
      payload_json: input.payloadJson || {},
    })
    .select('id')
    .single();

  if (error) throw error;
  return data;
}
