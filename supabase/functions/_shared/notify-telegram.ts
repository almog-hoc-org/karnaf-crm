// Shared Telegram notifier for operational alerts.
//
// Centralises Telegram fetch boilerplate so multiple sources (sla-worker,
// Sentry bridge, cron-failure watcher, payment 5xx surface) push to the
// same chat without duplicate code. Silently no-ops when the bot isn't
// configured — operator opts in by setting two env vars.
//
// Required env:
//   TELEGRAM_BOT_TOKEN      (e.g. 1234567890:ABC…)
//   TELEGRAM_ALERT_CHAT_ID  (positive for DM, negative for group)
//
// Optional env:
//   TELEGRAM_ALERT_THREAD_ID  (when the chat is a forum/topic group)

import { env, optional } from './env.ts';
import { log } from './logger.ts';

export type AlertSeverity = 'info' | 'warn' | 'error' | 'critical';
const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  info: 'ℹ️',
  warn: '⚠️',
  error: '🚨',
  critical: '🔥',
};

export interface TelegramAlert {
  source: string;
  severity: AlertSeverity;
  title: string;
  lines?: string[];
  link?: string;
  correlationId?: string;
}

export interface NotifyResult {
  sent: boolean;
  skipped?: 'no_token' | 'no_chat';
  status?: number;
  errorBody?: string;
}

export async function notifyTelegram(alert: TelegramAlert): Promise<NotifyResult> {
  const token = env.telegramBotToken();
  const chatId = env.telegramAlertChatId();
  if (!token) return { sent: false, skipped: 'no_token' };
  if (!chatId) return { sent: false, skipped: 'no_chat' };

  const emoji = SEVERITY_EMOJI[alert.severity] ?? '🛎';
  const header = `${emoji} ${alert.title}`;
  const tail: string[] = [];
  if (alert.lines && alert.lines.length > 0) tail.push(...alert.lines);
  if (alert.source) tail.push(`source: ${alert.source}`);
  if (alert.correlationId) tail.push(`correlation: ${alert.correlationId}`);
  if (alert.link) tail.push(alert.link);
  const text = [header, ...tail].join('\n');

  const threadId = optional('TELEGRAM_ALERT_THREAD_ID');
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (threadId) body.message_thread_id = Number(threadId);

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errBody = (await r.text()).slice(0, 300);
      log.warn('telegram_notify_failed', {
        fn: 'notify-telegram', source: alert.source,
        correlationId: alert.correlationId, status: r.status, body: errBody,
      });
      return { sent: false, status: r.status, errorBody: errBody };
    }
    return { sent: true, status: r.status };
  } catch (err) {
    log.warn('telegram_notify_exception', {
      fn: 'notify-telegram', source: alert.source,
      correlationId: alert.correlationId, err: String(err),
    });
    return { sent: false, errorBody: String(err) };
  }
}
