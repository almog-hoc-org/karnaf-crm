// Read every row of a PostgREST query, not just the first page.
//
// supabase/config.toml sets `max_rows = 1000`: the API silently truncates
// any response to 1,000 rows, whatever `.limit()` asks for. Broadcast
// audiences and recipient statistics were cut at 1,000 without a word —
// a 1,400-lead segment got 1,000 messages and reported "1,000 sent, done".
// Anything that must see all rows goes through here.
//
// This file IS the tested mirror of supabase/functions/_shared/paginate.ts;
// keep in sync.

export const PAGE_SIZE = 1000;

export interface PageResult<T> {
  data: T[] | null;
  error: unknown;
}

// `fetchPage(from, to)` must apply a stable ORDER BY (ending in a unique
// column) and `.range(from, to)`; otherwise rows can repeat or go missing
// between pages. Stops at the first short page, or once `max` rows are in.
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  opts: { pageSize?: number; max?: number } = {},
): Promise<T[]> {
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  // A small `max` (a 5-row preview sample) shouldn't pull a full page.
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? PAGE_SIZE, PAGE_SIZE, max));
  const out: T[] = [];
  for (let from = 0; out.length < max; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await fetchPage(from, to);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out.length > max ? out.slice(0, max) : out;
}

// Split rows into write batches so one upsert never carries an unbounded
// payload.
export function chunk<T>(rows: T[], size = PAGE_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
