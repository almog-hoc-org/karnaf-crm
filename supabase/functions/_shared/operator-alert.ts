// One place from which the CRM talks to its *operator* (as opposed to its
// leads). Fans out to WhatsApp, email and Telegram, records every attempt in
// `operator_alerts`, and throttles by subject so a standing problem is
// reported once rather than once per worker tick.
//
// Why this exists: before it, the only operator channel was Telegram, and
// Telegram was never configured in production — so all ten alert call sites
// were silent no-ops. Nothing in the system noticed. The owner's report was
// "אפס התראות", and the code agreed with him.
//
// Env (all optional; each channel is independently skipped when unset):
//   ALERT_WHATSAPP_TO  — international digits, no plus, e.g. 972559966175
//   RESEND_API_KEY     — from resend.com/api-keys, "Sending access"
//   ALERT_EMAIL_TO     — inbox that receives alerts
//   ALERT_EMAIL_FROM   — alerts@<verified domain>, or onboarding@resend.dev
//   TELEGRAM_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID — the pre-existing channel

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { optional } from './env.ts';
import { log } from './logger.ts';
import { notifyTelegram, type AlertSeverity } from './notify-telegram.ts';
import { sendWhatsAppTemplate, sendWhatsAppText } from './whatsapp-provider.ts';

export type { AlertSeverity };

export interface OperatorAlert {
  /** Coarse family, used for the digest watermark and the ops view. */
  kind: string;
  /**
   * Identity of the *subject*, not of the message. Two alerts about the
   * same stuck lead share a dedupe key and the second is dropped inside
   * the throttle window, however differently it is worded.
   */
  dedupeKey: string;
  severity: AlertSeverity;
  title: string;
  lines?: string[];
  link?: string;
  correlationId?: string;
  /**
   * Minutes to stay quiet about this dedupeKey after a successful send.
   * 0 disables throttling (self-tests, digests that already gate
   * themselves on having new content).
   */
  throttleMinutes?: number;
}

export interface ChannelResult {
  ok: boolean;
  skipped?: string;
  detail?: string;
}

export interface OperatorAlertResult {
  delivered: boolean;
  throttled: boolean;
  channels: Record<string, ChannelResult>;
}

const DEFAULT_THROTTLE_MINUTES = 60;

// WhatsApp template body params must be a single line (Meta #132018) and the
// fallback template's {{1}} is not unbounded. Keep the one-liner well inside.
const TEMPLATE_PARAM_LIMIT = 600;

export function alertChannelStatus(): Record<string, boolean> {
  return {
    whatsapp: Boolean(optional('ALERT_WHATSAPP_TO')),
    email: Boolean(optional('RESEND_API_KEY') && optional('ALERT_EMAIL_TO') && optional('ALERT_EMAIL_FROM')),
    telegram: Boolean(optional('TELEGRAM_BOT_TOKEN') && optional('TELEGRAM_ALERT_CHAT_ID')),
  };
}

/**
 * Compose, throttle, send and record. Never throws: an alert failing must
 * not take down the worker that raised it.
 */
export async function notifyOperator(
  supabase: SupabaseClient,
  alert: OperatorAlert,
): Promise<OperatorAlertResult> {
  const throttleMinutes = alert.throttleMinutes ?? DEFAULT_THROTTLE_MINUTES;
  try {
    if (throttleMinutes > 0 && await isThrottled(supabase, alert.dedupeKey, throttleMinutes)) {
      return { delivered: false, throttled: true, channels: {} };
    }
  } catch (err) {
    // A throttle-table failure must not silence the alert — err towards
    // sending. A duplicate message is a far cheaper mistake than a missed one.
    log.warn('operator_alert_throttle_check_failed', {
      fn: 'operator-alert', dedupeKey: alert.dedupeKey, err: String(err),
    });
  }

  const body = composeBody(alert);
  const oneLine = composeOneLine(alert);

  const [whatsapp, email, telegram] = await Promise.all([
    sendWhatsAppAlert(alert, oneLine),
    sendEmailAlert(alert, body),
    sendTelegramAlert(alert),
  ]);

  const channels: Record<string, ChannelResult> = { whatsapp, email, telegram };
  const delivered = Object.values(channels).some((c) => c.ok);

  if (!delivered) {
    log.warn('operator_alert_undelivered', {
      fn: 'operator-alert', kind: alert.kind, dedupeKey: alert.dedupeKey,
      correlationId: alert.correlationId, channels,
    });
  }

  try {
    await supabase.from('operator_alerts').insert({
      kind: alert.kind,
      dedupe_key: alert.dedupeKey,
      severity: alert.severity,
      title: alert.title,
      body,
      channel_results: channels,
      delivered,
      correlation_id: alert.correlationId ?? null,
    });
  } catch (err) {
    log.warn('operator_alert_log_failed', {
      fn: 'operator-alert', dedupeKey: alert.dedupeKey, err: String(err),
    });
  }

  return { delivered, throttled: false, channels };
}

async function isThrottled(
  supabase: SupabaseClient,
  dedupeKey: string,
  minutes: number,
): Promise<boolean> {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const { data, error } = await supabase
    .from('operator_alerts')
    .select('id')
    .eq('dedupe_key', dedupeKey)
    .eq('delivered', true)
    .gte('created_at', since)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

/**
 * Timestamp of the last alert of a kind that actually went out. The hourly
 * digest uses it as its watermark so it can report "what changed since you
 * last heard from me" instead of restating the whole backlog.
 */
export async function lastAlertAt(
  supabase: SupabaseClient,
  kind: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('operator_alerts')
    .select('created_at')
    .eq('kind', kind)
    .eq('delivered', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    log.warn('operator_alert_watermark_failed', { fn: 'operator-alert', kind, err: error.message });
    return null;
  }
  return (data?.created_at as string | undefined) ?? null;
}

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  info: 'ℹ️', warn: '⚠️', error: '🚨', critical: '🔥',
};

function composeBody(alert: OperatorAlert): string {
  const parts = [`${SEVERITY_EMOJI[alert.severity] ?? '🛎'} ${alert.title}`];
  if (alert.lines?.length) parts.push('', ...alert.lines);
  if (alert.link) parts.push('', alert.link);
  return parts.join('\n');
}

// WhatsApp may have to go out as a template, whose single parameter cannot
// contain a newline. Flatten to one line and clip.
function composeOneLine(alert: OperatorAlert): string {
  const parts = [alert.title, ...(alert.lines ?? []), alert.link ?? '']
    .filter(Boolean)
    .join(' · ')
    .replace(/\s+/g, ' ')
    .trim();
  return parts.length > TEMPLATE_PARAM_LIMIT
    ? `${parts.slice(0, TEMPLATE_PARAM_LIMIT - 1)}…`
    : parts;
}

async function sendWhatsAppAlert(alert: OperatorAlert, oneLine: string): Promise<ChannelResult> {
  const to = optional('ALERT_WHATSAPP_TO');
  if (!to) return { ok: false, skipped: 'no_alert_whatsapp_to' };

  // Freeform first: it is richer, and it works as long as the operator has
  // written to the business number within 24 hours — which, once alerts are
  // flowing and they reply to any of them, is the normal state.
  const freeform = await sendWhatsAppText(to, composeBody(alert)).catch((err) => ({
    ok: false as const, error: String(err),
  }));
  if (freeform.ok) return { ok: true, detail: 'freeform' };

  // Outside the window Meta rejects freeform, so fall back to the approved
  // template. Its single {{1}} carries the whole alert as one line.
  const templateName = optional('ALERT_WHATSAPP_TEMPLATE', optional('WHATSAPP_FALLBACK_TEMPLATE', 'karnaf_followup_v1'));
  const template = await sendWhatsAppTemplate(to, templateName, [{ name: '1', value: oneLine }])
    .catch((err) => ({ ok: false as const, error: String(err) }));
  if (template.ok) return { ok: true, detail: `template:${templateName}` };

  return {
    ok: false,
    detail: `freeform: ${freeform.error ?? 'failed'} | template: ${template.error ?? 'failed'}`.slice(0, 400),
  };
}

async function sendEmailAlert(alert: OperatorAlert, body: string): Promise<ChannelResult> {
  const apiKey = optional('RESEND_API_KEY');
  const to = optional('ALERT_EMAIL_TO');
  const from = optional('ALERT_EMAIL_FROM');
  if (!apiKey) return { ok: false, skipped: 'no_resend_key' };
  if (!to) return { ok: false, skipped: 'no_alert_email_to' };
  if (!from) return { ok: false, skipped: 'no_alert_email_from' };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: to.split(',').map((addr) => addr.trim()).filter(Boolean),
        subject: `${SEVERITY_EMOJI[alert.severity] ?? '🛎'} ${alert.title}`,
        text: body,
        html: renderHtml(alert, body),
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      log.warn('operator_alert_email_failed', {
        fn: 'operator-alert', status: res.status, body: detail,
        correlationId: alert.correlationId,
      });
      return { ok: false, detail: `${res.status}: ${detail}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: String(err).slice(0, 300) };
  }
}

function renderHtml(alert: OperatorAlert, body: string): string {
  const esc = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = (alert.lines ?? []).map((l) => `<li>${esc(l)}</li>`).join('');
  const link = alert.link
    ? `<p><a href="${esc(alert.link)}" style="color:#2563eb">${esc(alert.link)}</a></p>`
    : '';
  return [
    '<div dir="rtl" style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#0f172a">',
    `<h2 style="margin:0 0 8px">${SEVERITY_EMOJI[alert.severity] ?? '🛎'} ${esc(alert.title)}</h2>`,
    lines ? `<ul style="margin:0 0 12px;padding-inline-start:20px">${lines}</ul>` : '',
    link,
    `<p style="color:#64748b;font-size:12px;margin-top:16px">Karnaf CRM · ${esc(alert.kind)}${alert.correlationId ? ` · ${esc(alert.correlationId)}` : ''}</p>`,
    '</div>',
  ].filter(Boolean).join('') || esc(body);
}

async function sendTelegramAlert(alert: OperatorAlert): Promise<ChannelResult> {
  const result = await notifyTelegram({
    source: alert.kind,
    severity: alert.severity,
    title: alert.title,
    lines: alert.lines,
    link: alert.link,
    correlationId: alert.correlationId,
  });
  if (result.sent) return { ok: true };
  return { ok: false, skipped: result.skipped, detail: result.errorBody?.slice(0, 300) };
}
