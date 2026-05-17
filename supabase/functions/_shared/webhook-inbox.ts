// Helper for persisting raw webhook payloads before handler logic runs,
// so we can replay them if a handler crashes / a downstream is wedged.
//
// Usage in a webhook handler:
//
//   const rawBody = await req.text();
//   // ... auth check ...
//   const inboxId = await persistWebhookInbox(supabase, {
//     source: 'leads-intake',
//     req, rawBody, correlationId,
//   });
//   try {
//     // ... handler body ...
//     await finalizeWebhookInbox(supabase, inboxId, 'success');
//   } catch (err) {
//     await finalizeWebhookInbox(supabase, inboxId, 'server_error', String(err));
//     throw err;
//   }

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { log } from './logger.ts';

const SAFE_HEADERS = new Set([
  'x-hub-signature-256', 'x-karnaf-signature', 'x-signature',
  'content-type', 'user-agent', 'x-forwarded-for',
  'x-correlation-id', 'x-karnaf-source',
]);

function snapshotSafeHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) {
    const lk = k.toLowerCase();
    if (SAFE_HEADERS.has(lk)) out[lk] = v;
  }
  return out;
}

export type ProcessedStatus =
  | 'success' | 'duplicate' | 'rate_limited' | 'client_error'
  | 'server_error' | 'replay_failed';

export async function persistWebhookInbox(
  supabase: SupabaseClient,
  args: {
    source: string;
    req: Request;
    rawBody: string;
    correlationId: string;
    replayedFrom?: string | null;
  },
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('webhook_inbox')
      .insert({
        source: args.source,
        headers_json: snapshotSafeHeaders(args.req),
        body: args.rawBody,
        correlation_id: args.correlationId,
        replayed_from: args.replayedFrom ?? null,
      })
      .select('id')
      .single();
    if (error) {
      log.warn('webhook_inbox_insert_failed', { source: args.source, correlationId: args.correlationId, err: error.message });
      return null;
    }
    return data?.id ?? null;
  } catch (err) {
    log.warn('webhook_inbox_insert_exception', { source: args.source, correlationId: args.correlationId, err: String(err) });
    return null;
  }
}

export async function finalizeWebhookInbox(
  supabase: SupabaseClient,
  inboxId: string | null,
  status: ProcessedStatus,
  errorMessage?: string | null,
): Promise<void> {
  if (!inboxId) return;
  try {
    const { error } = await supabase
      .from('webhook_inbox')
      .update({
        processed_at: new Date().toISOString(),
        processed_status: status,
        error_message: errorMessage ?? null,
      })
      .eq('id', inboxId);
    if (error) {
      log.warn('webhook_inbox_finalize_failed', { inboxId, status, err: error.message });
    }
  } catch (err) {
    log.warn('webhook_inbox_finalize_exception', { inboxId, status, err: String(err) });
  }
}
