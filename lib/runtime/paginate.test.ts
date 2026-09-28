import { describe, expect, it } from 'vitest';
import { chunk, fetchAllPages } from './paginate';

// A fake PostgREST table that, like the real API behind max_rows, never
// returns more than `cap` rows per request.
function table(total: number, cap = 1000) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  const calls: Array<[number, number]> = [];
  const fetchPage = async (from: number, to: number) => {
    calls.push([from, to]);
    const end = Math.min(to + 1, from + cap);
    return { data: rows.slice(from, end), error: null };
  };
  return { fetchPage, calls };
}

describe('fetchAllPages', () => {
  it('reads past the 1,000-row API cap', async () => {
    const t = table(2345);
    const out = await fetchAllPages(t.fetchPage);
    expect(out).toHaveLength(2345);
    expect(out[2344]).toEqual({ id: 2344 });
    expect(t.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('makes one extra call when the total is an exact multiple of the page', async () => {
    const t = table(2000);
    expect(await fetchAllPages(t.fetchPage)).toHaveLength(2000);
    expect(t.calls).toHaveLength(3);
  });

  it('honours max', async () => {
    const t = table(5000);
    expect(await fetchAllPages(t.fetchPage, { max: 1500 })).toHaveLength(1500);
    expect(t.calls).toHaveLength(2);
  });

  it('never asks for a page larger than the cap', async () => {
    const t = table(10);
    await fetchAllPages(t.fetchPage, { pageSize: 5000 });
    expect(t.calls[0]).toEqual([0, 999]);
  });

  it('returns [] for an empty table and throws on error', async () => {
    expect(await fetchAllPages(table(0).fetchPage)).toEqual([]);
    const boom = new Error('boom');
    await expect(fetchAllPages(async () => ({ data: null, error: boom }))).rejects.toBe(boom);
  });
});

describe('chunk', () => {
  it('splits into fixed-size batches', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});

describe('fetchAllPages with a small max', () => {
  it('asks for exactly max rows in one call', async () => {
    const t = table(50);
    expect(await fetchAllPages(t.fetchPage, { max: 5 })).toHaveLength(5);
    expect(t.calls).toEqual([[0, 4]]);
  });
});
