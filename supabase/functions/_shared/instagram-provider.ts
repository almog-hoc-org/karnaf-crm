// Tier 8.A — Instagram Messaging provider (Meta "Instagram API with
// Instagram Login" route, graph.instagram.com).
//
// Inbound webhook shape is Messenger-style — object='instagram',
// entry[].messaging[] with sender.id = IGSID — completely different
// from WhatsApp's entry[].changes[].value.messages[], hence a separate
// normalizer instead of extending whatsapp-provider.
//
// Send: POST graph.instagram.com/<vN>/<IG_BUSINESS_ID>/messages with
// recipient.id = IGSID. Strict 24h window after the user's last inbound
// message and — unlike WhatsApp — NO template fallback outside it.
// Callers must queue manual replies instead (pending_manual_replies).

import type { OutboundSendResult } from './provider-types.ts';
import { optional } from './env.ts';
import { log } from './logger.ts';

const GRAPH_BASE = 'https://graph.instagram.com/v25.0';
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 300;

export const igEnv = {
  appSecret: () => optional('INSTAGRAM_APP_SECRET'),
  verifyToken: () => optional('INSTAGRAM_VERIFY_TOKEN'),
  accessToken: () => optional('INSTAGRAM_ACCESS_TOKEN'),
  businessId: () => optional('INSTAGRAM_BUSINESS_ID'),
};

export function instagramConfigured(): boolean {
  return !!(igEnv.accessToken() && igEnv.businessId());
}

export interface NormalizedInstagramMessage {
  igsid: string;
  providerMessageId: string | null;
  text: string | null;
  messageType: 'text' | 'media' | 'unknown';
  mediaType: string | null;
  rawPayload: Record<string, unknown>;
  receivedAt: string;
}

// Iterates entry[].messaging[]; skips echoes (our own outbound mirrored
// back), delivery/read receipts, and postbacks without text.
export function normalizeInstagramInbound(payload: Record<string, unknown>): NormalizedInstagramMessage[] {
  if (payload.object !== 'instagram' || !Array.isArray(payload.entry)) return [];
  const out: NormalizedInstagramMessage[] = [];
  for (const entry of payload.entry as Array<Record<string, unknown>>) {
    const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const event of messaging as Array<Record<string, unknown>>) {
      const message = event.message as Record<string, unknown> | undefined;
      if (!message) continue;
      if (message.is_echo === true) continue;
      const sender = event.sender as Record<string, unknown> | undefined;
      const igsid = typeof sender?.id === 'string' ? sender.id : null;
      if (!igsid) continue;
      const text = typeof message.text === 'string' && message.text.trim().length > 0 ? message.text : null;
      const attachments = Array.isArray(message.attachments) ? message.attachments as Array<Record<string, unknown>> : [];
      const mediaType = attachments.length > 0 && typeof attachments[0]?.type === 'string'
        ? attachments[0].type as string
        : null;
      const ts = typeof event.timestamp === 'number' ? new Date(event.timestamp).toISOString() : new Date().toISOString();
      out.push({
        igsid,
        providerMessageId: typeof message.mid === 'string' ? message.mid : null,
        text,
        messageType: text ? 'text' : mediaType ? 'media' : 'unknown',
        mediaType,
        rawPayload: event as Record<string, unknown>,
        receivedAt: ts,
      });
    }
  }
  return out;
}

async function withRetry<T>(label: string, fn: () => Promise<T>, retries = DEFAULT_RETRIES): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const jitter = Math.floor(Math.random() * 100);
      const delay = DEFAULT_BACKOFF_MS * Math.pow(2, attempt) + jitter;
      log.warn('instagram_retry', { fn: label, attempt, delay, err: String(err) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export async function sendInstagramText(igsid: string, text: string): Promise<OutboundSendResult> {
  if (!instagramConfigured()) return { ok: false, error: 'Instagram provider not configured' };
  return await withRetry('ig_text', async () => {
    const res = await fetch(`${GRAPH_BASE}/${igEnv.businessId()}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${igEnv.accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { id: igsid },
        message: { text },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status >= 500) throw new Error(`ig_5xx:${res.status}:${errText.slice(0, 120)}`);
      // 401/403 means the 60-day token expired or review lapsed —
      // surface loudly so Telegram alerting can catch it upstream.
      log.error('instagram_send_rejected', { fn: 'instagram-provider', status: res.status, err: errText.slice(0, 200) });
      return { ok: false, error: `ig ${res.status}: ${errText.slice(0, 200)}` };
    }
    const json = await res.json().catch(() => ({}));
    return { ok: true, providerMessageId: (json as Record<string, unknown>).message_id as string | undefined };
  });
}
