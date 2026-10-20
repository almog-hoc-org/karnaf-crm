import { useEffect } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { fetchAttentionInbox } from '@/lib/api';
import { kindLane } from '@lib/view-models/inbox-kinds';

/** InboxPage's list of attention rows. */
export const ATTENTION_INBOX_KEY = ['attention-inbox'] as const;
/** The nav badge's own copy of the same rows (see useAttentionCount for why). */
export const ATTENTION_COUNT_KEY = ['attention-count'] as const;

/**
 * Refetches BOTH attention queries. Every triage action must go through
 * here rather than invalidating the inbox list alone: the badge and the
 * tab title read their own key, so "טופל" would empty the list while the
 * sidebar kept the old count until the next 60s poll.
 */
export function invalidateAttention(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ATTENTION_INBOX_KEY }),
    qc.invalidateQueries({ queryKey: ATTENTION_COUNT_KEY }),
  ]);
}

// Attention counter for the nav badge + document title.
//
// Its OWN query key, on purpose. It used to share ['attention-inbox'] with
// InboxPage to save a request, but TanStack merges observers' refetch
// settings per key: this observer's 60s interval and focus refetch kept
// running while InboxPage had paused its own (a refetch mid-typing drops or
// reorders the card and takes the draft with it). One extra small request
// a minute is the cheaper mistake — and the inbox page keeps it honest
// through invalidateAttention() after every mutation.
//
// "Urgent" = the reply lane (customer wrote, waiting on us) plus
// snooze_due (an explicit "check again now" the operator scheduled).
// Overdue/ops rows are real work but not drop-everything work — they
// stay out of the badge so it keeps meaning "someone is waiting".
export function useAttentionCount(): number {
  const q = useQuery({
    queryKey: ATTENTION_COUNT_KEY,
    queryFn: () => fetchAttentionInbox(),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const rows = q.data ?? [];
  let count = 0;
  for (const row of rows) {
    if (kindLane(row.kind) === 'reply' || row.kind === 'snooze_due') count += 1;
  }
  return count;
}

const BASE_TITLE = 'Karnaf CRM';

/** Prefixes document.title with "(n)" while there are urgent rows. */
export function useAttentionTitle(count: number): void {
  useEffect(() => {
    document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
    return () => {
      document.title = BASE_TITLE;
    };
  }, [count]);
}
