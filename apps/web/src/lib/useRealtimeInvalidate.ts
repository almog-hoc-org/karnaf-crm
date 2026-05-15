import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from './supabase';

/**
 * Subscribe to Postgres `*` (insert/update/delete) events on `table` and
 * invalidate the given React Query keys whenever something changes. Cheap
 * to compose: every page that needs live data drops one of these in.
 *
 * Polite about failure: if the table isn't in the `supabase_realtime`
 * publication (migration 029) or the user is offline, we silently skip —
 * the page's own `useQuery` polling continues to work as a fallback. We
 * log to console so we can spot it in dev.
 */
export function useRealtimeInvalidate(
  table: string,
  queryKeys: Array<readonly unknown[]>,
  options: { filter?: string } = {},
) {
  const qc = useQueryClient();
  useEffect(() => {
    const channelName = `kf-rt-${table}-${Math.random().toString(36).slice(2, 8)}`;
    const channel = supabase.channel(channelName);

    channel.on(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      'postgres_changes' as any,
      // The `filter` option scopes broadcasts (e.g. `lead_id=eq.${leadId}`)
      // so a busy CRM with many open leads doesn't hammer every tab on
      // every inbound message.
      { event: '*', schema: 'public', table, filter: options.filter },
      () => {
        for (const key of queryKeys) {
          qc.invalidateQueries({ queryKey: key as readonly unknown[] });
        }
      },
    );

    channel.subscribe((status) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`[realtime] ${table}: ${status} — falling back to polling`);
      }
    });

    return () => {
      supabase.removeChannel(channel);
    };
    // queryKeys is by-reference; callers are expected to pass a stable array
    // (e.g. `['leads']` literals) or memoise. Same for `options.filter` —
    // pass a primitive string so the dep array compares cleanly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, qc, options.filter]);
}
