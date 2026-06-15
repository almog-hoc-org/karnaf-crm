import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Provider message id is unique-indexed (ux_messages_provider_message_id),
// so the cheapest correctness check is to ask Postgres. We keep an explicit
// pre-check to short-circuit before doing any work.
export async function messageAlreadyLogged(
  supabase: SupabaseClient,
  providerMessageId: string | null,
): Promise<boolean> {
  if (!providerMessageId) return false;
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('provider_message_id', providerMessageId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}
