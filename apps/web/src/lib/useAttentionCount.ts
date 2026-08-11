import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchAttentionInbox } from '@/lib/api';
import { kindLane } from '@lib/view-models/inbox-kinds';

// Attention counter for the nav badge + document title. Shares the
// ['attention-inbox'] cache with InboxPage so opening the inbox never
// double-fetches; this observer just adds a slower background interval
// for when the operator is elsewhere in the app.
//
// "Urgent" = the reply lane (customer wrote, waiting on us) plus
// snooze_due (an explicit "check again now" the operator scheduled).
// Overdue/ops rows are real work but not drop-everything work — they
// stay out of the badge so it keeps meaning "someone is waiting".
export function useAttentionCount(): number {
  const q = useQuery({
    queryKey: ['attention-inbox'],
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
