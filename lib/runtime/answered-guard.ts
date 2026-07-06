// Node-side mirror of supabase/functions/_shared/answered-guard.ts — keep
// in sync. Pure decision logic for orchestrate-message's "already answered"
// coalescing guard.
//
//
// History: the old guard skipped whenever the newest message in the
// conversation was outbound. That silently swallowed a real customer
// message in one race: msg2 arrives while turn-1's LLM call is in
// flight — turn-1's reply gets a LATER created_at than msg2, so the
// dispatch for msg2 sees "latest is outbound" and skips, yet the reply
// never saw msg2. The watchdog is blind too (last_outbound_at >
// last_inbound_at), so nobody ever answers.
//
// Fix: every AI reply now records WHICH inbound its context covered
// (raw_payload.context_last_inbound_at, set from the same snapshot the
// LLM saw). The guard only skips when the latest outbound's marker
// covers the newest inbound. Legacy outbounds without a marker keep the
// old skip behaviour — markers accumulate immediately after deploy.

export interface GuardMessage {
  direction: string;
  created_at: string;
  raw_payload?: Record<string, unknown> | null;
}

// Newest inbound timestamp in the (ascending) snapshot, or null.
export function latestInboundAt(ordered: GuardMessage[]): string | null {
  for (let i = ordered.length - 1; i >= 0; i--) {
    const m = ordered[i];
    if (m && m.direction === 'inbound') return m.created_at;
  }
  return null;
}

// True when this dispatch is a genuine duplicate: the newest message is
// outbound AND that outbound's context already included the newest
// inbound. False means there is (or may be) an unanswered customer
// message — proceed to answer.
export function coveredByLatestReply(ordered: GuardMessage[]): boolean {
  const latest = ordered[ordered.length - 1];
  if (!latest || latest.direction !== 'outbound') return false;

  const inboundAt = latestInboundAt(ordered);
  if (!inboundAt) return true; // outbound-only window — nothing unanswered

  const marker = latest.raw_payload?.context_last_inbound_at;
  if (typeof marker === 'string') {
    const markerTs = Date.parse(marker);
    const inboundTs = Date.parse(inboundAt);
    if (Number.isFinite(markerTs) && Number.isFinite(inboundTs)) {
      return markerTs >= inboundTs;
    }
  }
  // Legacy outbound without a marker (pre-deploy rows): preserve the old
  // behaviour rather than re-answering historical conversations.
  return true;
}
