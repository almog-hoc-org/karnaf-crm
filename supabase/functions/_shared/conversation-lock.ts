// Per-conversation turn lease, so two concurrent invocations for the same
// conversation (a Meta retry, two quick customer messages) cannot both run
// the orchestrator and double-send.
//
// Until migration 138 this was pg_try_advisory_lock — a SESSION-level lock
// taken and released over two separate PostgREST requests. The API serves
// each request from whichever pooled connection is free, so the lock lived
// on connection A and the unlock ran on connection B (returning false). The
// lock stayed on A until the connection was recycled, and every later turn
// for that conversation that landed on another connection came back
// `locked`; dispatch-outbound retried it at 1m/4m/16m/1h and dead-lettered.
// The customer's second message was never answered.
//
// Now one conditional UPDATE on conversations.turn_lock_until claims the
// turn for a bounded time (claim_conversation_turn), and the release clears
// it. No connection affinity, and a turn that dies mid-way frees itself when
// the lease expires. Same exported API as before.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.117.2';

// Longer than a full orchestrator turn (model call + send, 25s dispatch
// timeout) by a wide margin; short enough that a crashed turn does not
// hold the customer's next message for long.
const TURN_LEASE_SECONDS = 180;

export async function tryConversationLock(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('claim_conversation_turn', {
    p_conversation_id: conversationId,
    p_ttl_seconds: TURN_LEASE_SECONDS,
  });
  // Fail closed: if the claim RPC itself errors we can't know whether a
  // concurrent turn holds the lease — proceeding could double-send. The
  // caller returns skipped:'locked' and dispatch-outbound's bounded
  // retries pick the turn up again.
  if (error) {
    console.warn('conversation_lock_rpc_error', { conversationId, error: error.message });
    return false;
  }
  return data === true;
}

export async function releaseConversationLock(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<void> {
  const { error } = await supabase.rpc('release_conversation_turn', { p_conversation_id: conversationId });
  if (error) console.warn('conversation_unlock_rpc_error', { conversationId, error: error.message });
}
