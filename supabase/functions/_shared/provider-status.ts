// Delivery receipts (sent / delivered / read / failed) → messages and
// broadcast_recipients. The pure parsing half is mirrored in
// lib/runtime/provider-status.ts, where it is unit-tested — keep in sync.
//
// Meta sends receipts to the SAME callback URL as customer messages (one
// URL per app), i.e. to whatsapp-webhook. Until 28.9 that webhook filed
// every receipt as "unsupported_payload", and provider-status-webhook — the
// only code that applied them — never received a call: WhatsApp
// delivered/read and late failures were never recorded. Both webhooks now
// call applyProviderStatuses.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

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


export interface ApplyStatusesResult {
  received: number;
  /** Receipts that matched a message we sent (alerts to the owner don't). */
  matched: number;
  failed: number;
}

export async function applyProviderStatuses(
  supabase: SupabaseClient,
  statuses: ProviderStatus[],
  correlationId: string,
): Promise<ApplyStatusesResult> {
  const result: ApplyStatusesResult = { received: statuses.length, matched: 0, failed: 0 };
  for (const s of statuses) {
    const { data: message } = await supabase
      .from('messages')
      .select('id, lead_id, conversation_id, provider_status')
      .eq('provider_message_id', s.providerMessageId)
      .maybeSingle();
    if (!message) continue;
    result.matched++;

    const updates: Record<string, unknown> = {};
    const ts = new Date().toISOString();
    if (shouldAdvanceStatus(message.provider_status as string | null, s.status)) updates.provider_status = s.status;
    if (s.status === 'delivered') updates.delivered_at = ts;
    if (s.status === 'read') updates.read_at = ts;
    if (s.status === 'failed') {
      updates.provider_error = s.errorCode ? `${s.errorCode}: ${s.errorMessage ?? ''}`.trim() : s.errorMessage;
      result.failed++;
    }
    if (Object.keys(updates).length > 0) {
      await supabase.from('messages').update(updates).eq('id', message.id);
    }

    // A provider-side failure (bad number, marketing limit #131049, template
    // rejection) arrives AFTER dispatch-outbound marked the recipient 'sent'.
    // Roll it up so the broadcast counts it as failed and the pause guard
    // sees it. delivered/read need no rollup — recipientStats joins messages.
    if (s.status === 'failed') {
      await supabase
        .from('broadcast_recipients')
        .update({ status: 'failed', error: (updates.provider_error as string | null) ?? 'provider failure' })
        .eq('message_id', message.id);
    }

    // Only failures go on the lead's timeline: sent/delivered/read for every
    // broadcast recipient would be three rows each, the lead_events flood
    // shape of migration 123. Those states live on the message row.
    if (s.status === 'failed') {
      await supabase.from('lead_events').insert({
        lead_id: message.lead_id,
        conversation_id: message.conversation_id,
        event_type: 'provider_message_status_updated',
        actor_type: 'provider',
        event_payload: {
          provider_message_id: s.providerMessageId, status: s.status,
          error_code: s.errorCode, error_message: s.errorMessage, correlation_id: correlationId,
        },
      });
    }
  }
  return result;
}
