// Postgres advisory locks scoped per conversation. Two int4 keys map to the
// `pg_try_advisory_lock(int, int)` form so concurrent webhook invocations
// for the same conversation can't race past the orchestrator.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const NAMESPACE = 0x4b524e46; // 'KRNF'

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Coerce into the signed int4 range Postgres expects.
  return hash > 0x7fffffff ? hash - 0x100000000 : hash;
}

export async function tryConversationLock(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  const key = fnv1a32(conversationId);
  const { data, error } = await supabase.rpc('try_conversation_lock', { p_namespace: NAMESPACE, p_key: key });
  // Fail closed: if the lock RPC itself errors we can't know whether a
  // concurrent turn holds the lock — proceeding could double-send. The
  // caller returns skipped:'locked' and dispatch-outbound's bounded
  // retries pick the turn up again.
  if (error) {
    console.warn('conversation_lock_rpc_error', { conversationId, error: error.message });
    return false;
  }
  return Boolean(data);
}

export async function releaseConversationLock(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<void> {
  const key = fnv1a32(conversationId);
  await supabase.rpc('release_conversation_lock', { p_namespace: NAMESPACE, p_key: key });
}
