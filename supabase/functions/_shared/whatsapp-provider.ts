// Provider-aware WhatsApp adapter. Wraps Meta Cloud API and WATI behind one
// interface, supports freeform/template send modes, and applies a small
// jittered retry on transient failures (5xx / network).

import { toWhatsAppPhone } from './phone.ts';
import type { NormalizedInboundMessage, OutboundSendResult, TemplateParam } from './provider-types.ts';
import { env } from './env.ts';
import { log } from './logger.ts';

const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 400;

export type ProviderName = 'meta_cloud_api' | 'wati' | 'none';

export function activeProvider(): ProviderName {
  if (env.whatsappToken() && env.whatsappPhoneId()) return 'meta_cloud_api';
  if (env.watiToken()) return 'wati';
  return 'none';
}

export function normalizeProviderInbound(payload: Record<string, unknown>): NormalizedInboundMessage | null {
  const now = new Date().toISOString();

  const entry = (payload.entry as Array<Record<string, unknown>> | undefined)?.[0];
  const changes = (entry?.changes as Array<Record<string, unknown>> | undefined)?.[0];
  const value = changes?.value as Record<string, unknown> | undefined;
  const messages = value?.messages as Array<Record<string, unknown>> | undefined;

  if (messages?.[0]) {
    const msg = messages[0];
    const contacts = value?.contacts as Array<Record<string, unknown>> | undefined;
    const contact = contacts?.[0];
    const profile = contact?.profile as Record<string, unknown> | undefined;
    const textObj = msg.text as Record<string, unknown> | undefined;
    const type = typeof msg.type === 'string' ? msg.type : 'unknown';

    return {
      provider: 'meta_cloud_api',
      providerMessageId: typeof msg.id === 'string' ? msg.id : null,
      phone: String(msg.from || ''),
      senderName: typeof profile?.name === 'string' ? profile.name : null,
      text: typeof textObj?.body === 'string' ? textObj.body : null,
      messageType: type === 'text' ? 'text' : type === 'unknown' ? 'unknown' : 'media',
      mediaType: type === 'text' ? null : type,
      rawPayload: payload,
      receivedAt: now,
    };
  }

  if (typeof payload.waId === 'string' || typeof payload.senderPhone === 'string'
      || typeof payload.phone === 'string' || typeof payload.from === 'string') {
    const message = payload.message as Record<string, unknown> | undefined;
    const text = typeof payload.text === 'string'
      ? payload.text
      : typeof message?.text === 'string' ? String(message.text) : null;
    return {
      provider: 'wati',
      providerMessageId: typeof payload.id === 'string' ? payload.id : null,
      phone: String(payload.waId || payload.senderPhone || payload.phone || payload.from || ''),
      senderName:
        typeof payload.senderName === 'string' ? payload.senderName :
        typeof payload.pushName === 'string' ? payload.pushName :
        typeof payload.name === 'string' ? payload.name : null,
      text,
      messageType: text ? 'text' : 'unknown',
      rawPayload: payload,
      receivedAt: now,
    };
  }
  return null;
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
      log.warn('whatsapp_retry', { fn: label, attempt, delay, err: String(err) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export async function sendWhatsAppText(phone: string, text: string): Promise<OutboundSendResult> {
  const provider = activeProvider();
  if (provider === 'meta_cloud_api') return withRetry('meta_text', () => sendMetaText(phone, text));
  if (provider === 'wati') return withRetry('wati_text', () => sendWatiText(phone, text));
  return { ok: false, error: 'No WhatsApp provider configured' };
}

// Meta rejects template body params containing newlines, tabs, or more
// than 4 consecutive spaces (error #132018) — a multi-line AI reply
// wrapped in the fallback template gets stuck retrying forever otherwise.
export function sanitizeTemplateParam(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export async function sendWhatsAppTemplate(
  phone: string,
  templateName: string,
  params: TemplateParam[] = [],
  language = 'he',
): Promise<OutboundSendResult> {
  const provider = activeProvider();
  const clean = params.map((p) => ({ ...p, value: sanitizeTemplateParam(p.value) }));
  if (provider === 'meta_cloud_api') return withRetry('meta_template', () => sendMetaTemplate(phone, templateName, clean, language));
  if (provider === 'wati') return withRetry('wati_template', () => sendWatiTemplate(phone, templateName, clean));
  return { ok: false, error: 'No WhatsApp provider configured' };
}

async function sendMetaText(phone: string, text: string): Promise<OutboundSendResult> {
  const to = toWhatsAppPhone(phone);
  const res = await fetch(`https://graph.facebook.com/v21.0/${env.whatsappPhoneId()}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.whatsappToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    if (res.status >= 500) throw new Error(`meta_5xx:${res.status}:${errText.slice(0, 120)}`);
    return { ok: false, error: errText };
  }
  const json = await res.json();
  return { ok: true, providerMessageId: json.messages?.[0]?.id as string | undefined };
}

async function sendMetaTemplate(
  phone: string,
  templateName: string,
  params: TemplateParam[],
  language: string,
): Promise<OutboundSendResult> {
  const to = toWhatsAppPhone(phone);
  const res = await fetch(`https://graph.facebook.com/v21.0/${env.whatsappPhoneId()}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.whatsappToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        components: params.length
          ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p.value })) }]
          : undefined,
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    if (res.status >= 500) throw new Error(`meta_5xx:${res.status}:${errText.slice(0, 120)}`);
    return { ok: false, error: errText };
  }
  const json = await res.json();
  return { ok: true, providerMessageId: json.messages?.[0]?.id as string | undefined };
}

async function sendWatiText(phone: string, text: string): Promise<OutboundSendResult> {
  const to = toWhatsAppPhone(phone);
  const res = await fetch(
    `${env.watiApiUrl()}/api/v1/sendSessionMessage/${to}?messageText=${encodeURIComponent(text)}`,
    { method: 'POST', headers: { Authorization: `Bearer ${env.watiToken()}` } },
  );
  if (!res.ok) {
    const errText = await res.text();
    if (res.status >= 500) throw new Error(`wati_5xx:${res.status}:${errText.slice(0, 120)}`);
    return { ok: false, error: errText };
  }
  return { ok: true };
}

async function sendWatiTemplate(
  phone: string,
  templateName: string,
  params: TemplateParam[],
): Promise<OutboundSendResult> {
  const to = toWhatsAppPhone(phone);
  const res = await fetch(`${env.watiApiUrl()}/api/v1/sendTemplateMessage?whatsappNumber=${to}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.watiToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      template_name: templateName,
      broadcast_name: `karnaf_${templateName}`,
      parameters: params.map((p) => ({ name: p.name, value: p.value })),
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    if (res.status >= 500) throw new Error(`wati_5xx:${res.status}:${errText.slice(0, 120)}`);
    return { ok: false, error: errText };
  }
  return { ok: true };
}
