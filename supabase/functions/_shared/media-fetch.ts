// WhatsApp media archival. The inbound webhook fires this in the background
// (non-blocking); failures are logged but never throw back to the caller —
// missing media simply leaves `media_storage_path` null and the operator
// console falls back to the provider's transient URL stored in raw_payload.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.117.2';
import { env } from './env.ts';
import { log } from './logger.ts';

const BUCKET = 'whatsapp-media';

interface FetchInput {
  messageId: string;
  providerMessageId: string | null;
  rawPayload: Record<string, unknown>;
  conversationId: string;
}

export async function archiveWhatsAppMedia(
  supabase: SupabaseClient,
  input: FetchInput,
  correlationId: string,
): Promise<{ ok: boolean; storagePath?: string; error?: string }> {
  const mediaId = extractMetaMediaId(input.rawPayload);
  if (!mediaId) return { ok: false, error: 'no_media_id_in_payload' };

  const token = env.whatsappToken();
  if (!token) return { ok: false, error: 'no_whatsapp_token' };

  try {
    // 1. Resolve the temporary download URL via the Meta media endpoint.
    const lookup = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!lookup.ok) {
      const text = await lookup.text();
      return { ok: false, error: `meta_lookup_${lookup.status}:${text.slice(0, 120)}` };
    }
    const lookupJson = await lookup.json();
    const url = lookupJson.url as string | undefined;
    const mimeType = (lookupJson.mime_type as string | undefined) ?? 'application/octet-stream';
    if (!url) return { ok: false, error: 'meta_lookup_missing_url' };

    // 2. Download the binary (Meta requires the same bearer token).
    const binary = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!binary.ok) {
      const text = await binary.text();
      return { ok: false, error: `meta_download_${binary.status}:${text.slice(0, 120)}` };
    }
    const bytes = new Uint8Array(await binary.arrayBuffer());

    // 3. Upload to the private bucket using a stable, deterministic path so
    //    re-deliveries (rare but possible) don't fan out duplicates.
    const ext = mimeToExtension(mimeType);
    const path = `${input.conversationId}/${input.messageId}${ext}`;
    const upload = await supabase.storage.from(BUCKET).upload(path, bytes, {
      contentType: mimeType,
      upsert: true,
    });
    if (upload.error) return { ok: false, error: `storage_upload:${upload.error.message}` };

    // 4. Persist the canonical path on the message row.
    const { error: updateErr } = await supabase
      .from('messages')
      .update({ media_storage_path: path })
      .eq('id', input.messageId);
    if (updateErr) return { ok: false, error: `messages_update:${updateErr.message}` };

    log.info('whatsapp_media_archived', {
      fn: 'archiveWhatsAppMedia', correlationId,
      messageId: input.messageId, conversationId: input.conversationId, bytes: bytes.length,
    });
    return { ok: true, storagePath: path };
  } catch (err) {
    log.error('whatsapp_media_failed', {
      fn: 'archiveWhatsAppMedia', correlationId,
      messageId: input.messageId, err: String(err),
    });
    return { ok: false, error: String(err) };
  }
}

function extractMetaMediaId(payload: Record<string, unknown>): string | null {
  const entry = (payload.entry as Array<Record<string, unknown>> | undefined)?.[0];
  const changes = (entry?.changes as Array<Record<string, unknown>> | undefined)?.[0];
  const value = changes?.value as Record<string, unknown> | undefined;
  const message = (value?.messages as Array<Record<string, unknown>> | undefined)?.[0];
  if (!message) return null;
  for (const kind of ['image', 'audio', 'video', 'document', 'sticker']) {
    const obj = message[kind] as Record<string, unknown> | undefined;
    if (obj && typeof obj.id === 'string') return obj.id;
  }
  return null;
}

function mimeToExtension(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    case 'application/pdf': return '.pdf';
    case 'audio/ogg': return '.ogg';
    case 'audio/mpeg': return '.mp3';
    case 'audio/mp4': return '.m4a';
    case 'audio/aac': return '.aac';
    case 'video/mp4': return '.mp4';
    case 'video/3gpp': return '.3gp';
    default: return '';
  }
}
