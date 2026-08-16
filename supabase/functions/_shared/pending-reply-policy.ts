// When is a parked manual reply too old or too tried to send? Mirrored in
// lib/runtime/pending-reply-policy.ts for unit tests; keep in sync.
//
// A reply written by a rep while the 24h WhatsApp window was shut is parked
// and flushed the moment the customer writes again. The flush query selects
// status IN ('queued','reopen_sent','failed') with no attempt counter and
// no age limit, so a row that keeps failing was retried on EVERY subsequent
// inbound, forever — and a reply drafted months ago would still be
// delivered the next time that customer said hello. Both are wrong for the
// same reason: a stale answer is worse than no answer.

export const PENDING_REPLY_MAX_ATTEMPTS = 5;
export const PENDING_REPLY_MAX_AGE_DAYS = 14;

export interface PendingReplyRow {
  attempts?: number | null;
  queued_at?: string | null;
}

export type PendingReplyDecision =
  | { send: true }
  | { send: false; reason: 'too_many_attempts' | 'too_old' };

export function pendingReplyDecision(
  row: PendingReplyRow,
  now: Date = new Date(),
  maxAttempts: number = PENDING_REPLY_MAX_ATTEMPTS,
  maxAgeDays: number = PENDING_REPLY_MAX_AGE_DAYS,
): PendingReplyDecision {
  const attempts = typeof row.attempts === 'number' ? row.attempts : 0;
  if (attempts >= maxAttempts) return { send: false, reason: 'too_many_attempts' };

  const queuedMs = row.queued_at ? Date.parse(row.queued_at) : NaN;
  // An unparseable or missing timestamp is not a reason to expire a reply;
  // the attempt counter still bounds it.
  if (Number.isFinite(queuedMs) && now.getTime() - queuedMs > maxAgeDays * 86_400_000) {
    return { send: false, reason: 'too_old' };
  }
  return { send: true };
}
