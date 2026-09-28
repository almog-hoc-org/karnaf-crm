// Delivery-receipt parsing — pure logic. This file IS the tested mirror of
// the pure half of supabase/functions/_shared/provider-status.ts; keep the
// two in sync.
//
// Meta sends message receipts (sent / delivered / read / failed) to the
// SAME callback URL as customer messages — one URL per app — so
// whatsapp-webhook receives them. Until 28.9 it filed every receipt as
// "unsupported_payload" and dropped it, and the separate
// provider-status-webhook never received anything: WhatsApp delivered/read
// and late failures were never recorded.

export interface ProviderStatus {
  providerMessageId: string;
  status: string;
  errorCode: number | null;
  errorMessage: string | null;
}

type Obj = Record<string, unknown>;

function asArray(v: unknown): Obj[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Obj[]) : [];
}

function toStatus(item: Obj): ProviderStatus | null {
  const id = item.id ?? item.message_id;
  if (typeof id !== 'string' || !id) return null;
  const err = asArray(item.errors)[0] ?? (item.error && typeof item.error === 'object' ? item.error as Obj : null);
  const code = err?.code;
  return {
    providerMessageId: id,
    status: String(item.status ?? 'unknown').toLowerCase(),
    errorCode: typeof code === 'number' ? code : typeof code === 'string' && /^\d+$/.test(code) ? Number(code) : null,
    errorMessage: typeof err?.message === 'string' ? err.message
      : typeof err?.title === 'string' ? err.title : null,
  };
}

/**
 * Every receipt in a webhook body. Meta: entry[].changes[].value.statuses[]
 * (all entries and changes, not just the first). WATI-style flat bodies:
 * top-level `statuses[]`, or a single {message_id|id, status}.
 * Returns [] when the body carries no receipt.
 */
export function extractProviderStatuses(body: unknown): ProviderStatus[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as Obj;
  const out: ProviderStatus[] = [];
  for (const entry of asArray(b.entry)) {
    for (const change of asArray(entry.changes)) {
      const value = change.value && typeof change.value === 'object' ? change.value as Obj : {};
      for (const item of asArray(value.statuses)) {
        const s = toStatus(item);
        if (s) out.push(s);
      }
    }
  }
  if (out.length > 0 || Array.isArray(b.entry)) return out;
  for (const item of asArray(b.statuses)) {
    const s = toStatus(item);
    if (s) out.push(s);
  }
  if (out.length > 0) return out;
  if (typeof b.status === 'string' && (typeof b.message_id === 'string' || typeof b.id === 'string')) {
    const s = toStatus(b);
    if (s) out.push(s);
  }
  return out;
}

/** Status precedence — a late 'delivered' must not overwrite 'read'. */
const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

export function shouldAdvanceStatus(current: string | null | undefined, next: string): boolean {
  const cur = RANK[(current ?? '').toLowerCase()] ?? 0;
  const nxt = RANK[next.toLowerCase()] ?? 0;
  return nxt > cur || nxt === 0;
}
