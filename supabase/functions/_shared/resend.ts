// Resend (resend.com) REST client for outgoing email.
//
// Two callers today: the operator alert channel (_shared/operator-alert.ts,
// which predates this module and keeps its own fetch) and the email
// broadcast dispatcher, which sends one message PER RECIPIENT and records
// the provider id on broadcast_recipients. That is the difference from the
// Rav Messer path, where the CRM pushed addresses into a Responder list and
// Responder sent the campaign: with Resend the CRM owns the send, so it also
// owns the unsubscribe link and the List-Unsubscribe headers (חוק הספאם).
//
// The pure classification helpers are mirrored in lib/runtime/resend-outcome.ts
// where they are unit-tested — keep the two in sync.

import { env } from './env.ts';
import { log } from './logger.ts';

const API_BASE = 'https://api.resend.com';

export type ResendOutcome = 'ok' | 'retryable' | 'fatal';

export function classifyResendStatus(status: number): ResendOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 0 || status === 408 || status === 429 || status >= 500) return 'retryable';
  return 'fatal';
}

export function emailDomain(address: string): string {
  const trimmed = address.trim();
  const angled = /<([^>]+)>/.exec(trimmed);
  const bare = (angled?.[1] ?? trimmed).trim();
  const at = bare.lastIndexOf('@');
  if (at < 0) return '';
  return bare.slice(at + 1).toLowerCase();
}

const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'live.com',
  'yahoo.com', 'walla.com', 'walla.co.il', 'icloud.com', 'me.com',
]);

export function isPublicMailDomain(domain: string): boolean {
  return PUBLIC_MAIL_DOMAINS.has(domain.toLowerCase());
}

export function isResendConfigured(): boolean {
  return !!env.resendApiKey();
}

export interface SendEmailInput {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  tags?: Array<{ name: string; value: string }>;
  /** Resend dedupes identical keys for 24h — our guard against a double
   *  send when the DB write after a successful send fails. */
  idempotencyKey?: string;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  status: number;
  outcome: ResendOutcome;
  error?: string;
}

/** Resend tag values accept letters, digits, underscore and dash only. */
function safeTagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 250) || 'none';
}

export async function sendResendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = env.resendApiKey();
  if (!apiKey) return { ok: false, status: 0, outcome: 'fatal', error: 'resend not configured' };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey.slice(0, 256);

  const body: Record<string, unknown> = {
    from: input.from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
  };
  if (input.text) body.text = input.text;
  if (input.replyTo) body.reply_to = input.replyTo;
  if (input.headers) body.headers = input.headers;
  if (input.tags) body.tags = input.tags.map((t) => ({ name: t.name, value: safeTagValue(t.value) }));

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/emails`, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    return { ok: false, status: 0, outcome: 'retryable', error: String(err).slice(0, 300) };
  }

  const raw = await res.text();
  if (!res.ok) {
    const outcome = classifyResendStatus(res.status);
    let message = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as { message?: string; error?: string; name?: string };
      message = (parsed.message ?? parsed.error ?? parsed.name ?? message).slice(0, 300);
    } catch { /* keep the raw body */ }
    log.warn('resend_send_failed', { fn: 'resend', status: res.status, outcome, err: message });
    return { ok: false, status: res.status, outcome, error: message };
  }

  let id: string | undefined;
  try {
    id = (JSON.parse(raw) as { id?: string }).id;
  } catch { /* a 2xx without a parsable body still counts as sent */ }
  return { ok: true, id, status: res.status, outcome: 'ok' };
}

export interface ResendDomain { name: string; status: string }

/** GET /domains — used by the scheduling preflight so a campaign is never
 *  scheduled against a from-address Resend will reject at send time. */
export async function listResendDomains(): Promise<{ ok: boolean; domains: ResendDomain[]; error?: string }> {
  const apiKey = env.resendApiKey();
  if (!apiKey) return { ok: false, domains: [], error: 'resend not configured' };
  try {
    const res = await fetch(`${API_BASE}/domains`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const raw = await res.text();
    if (!res.ok) return { ok: false, domains: [], error: `${res.status}: ${raw.slice(0, 200)}` };
    const parsed = JSON.parse(raw) as { data?: Array<{ name?: string; status?: string }> };
    const domains = (parsed.data ?? [])
      .filter((d) => typeof d.name === 'string')
      .map((d) => ({ name: String(d.name).toLowerCase(), status: String(d.status ?? '') }));
    return { ok: true, domains };
  } catch (err) {
    return { ok: false, domains: [], error: String(err).slice(0, 200) };
  }
}
