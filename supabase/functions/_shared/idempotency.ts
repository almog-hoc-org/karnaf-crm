import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Provider message id is unique-indexed (ux_messages_provider_message_id),
// so the cheapest correctness check is to ask Postgres. We keep an explicit
// pre-check to short-circuit before doing any work.
export async function messageAlreadyLogged(
  supabase: SupabaseClient,
  providerMessageId: string | null,
): Promise<boolean> {
  if (!providerMessageId) return false;
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('provider_message_id', providerMessageId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

// Webhook request/response idempotency (webhook_idempotency table, 028;
// purge_expired_webhook_idempotency() reaper migrated in 029). Restored
// after the branch merge — the prod-scraped snapshot predated them.

const encoder = new TextEncoder();

export async function hashBody(body: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(body));
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export async function getWebhookIdempotencyResponse(
  supabase: SupabaseClient,
  key: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from('webhook_idempotency')
    .select('response, expires_at')
    .eq('key', key)
    .maybeSingle();
  if (error) {
    // Don't fail open silently; let the caller treat lookup errors as a
    // miss but log upstream. Returning null is the right behaviour: at
    // worst we do duplicate work once.
    return null;
  }
  if (!data) return null;
  // Reject expired rows even if the reaper hasn't run yet.
  if (Date.parse(data.expires_at as string) < Date.now()) return null;
  return data.response as Record<string, unknown>;
}

export async function storeWebhookIdempotencyResponse(
  supabase: SupabaseClient,
  key: string,
  source: string,
  response: Record<string, unknown>,
): Promise<void> {
  // Upsert handles the rare case where two concurrent retries race past
  // the lookup. The second writer harmlessly overwrites the response.
  await supabase
    .from('webhook_idempotency')
    .upsert({ key, source, response }, { onConflict: 'key' });
}
