// Real-time operator alerts on inbound customer messages.
//
// Two distinct alerts, because they answer two different questions:
//
//   maybeAlertHumanInbound — "a lead you personally own is waiting on you".
//     Fires only for human-owned leads, throttled per lead.
//
//   alertInboundWindowOpened — "a 24-hour WhatsApp window just opened".
//     Fires for EVERY lead, AI-owned included, the moment someone writes in
//     after the previous window had closed. This is the one the owner asked
//     for: inside those 24 hours we may send freeform WhatsApp, and outside
//     them we are limited to approved templates, so a newly opened window is
//     a perishable opportunity. Previously nothing whatsoever was emitted
//     when a customer wrote to the bot.
//
// Both route through _shared/operator-alert.ts, so they reach WhatsApp,
// email and Telegram rather than Telegram alone (which production never had
// configured, making every one of these a silent no-op).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getRuntimeConfig } from './config-service.ts';
import { logLeadEvent } from './lead-service.ts';
import { notifyOperator } from './operator-alert.ts';
import { log } from './logger.ts';

const THROTTLE_MINUTES = 10;
const APP_BASE_URL = 'https://karnaf-crm.vercel.app';

// Matches the WhatsApp freeform window. An inbound arriving with the last
// one older than this (or absent) means a fresh window just opened.
const WINDOW_HOURS = 24;

export async function maybeAlertHumanInbound(
  supabase: SupabaseClient,
  input: {
    leadId: string;
    leadName?: string | null;
    phone?: string | null;
    snippet?: string | null;
    correlationId: string;
  },
): Promise<void> {
  try {
    const config = await getRuntimeConfig(supabase);
    if (!config.notifications.perInboundTelegram) return;

    const since = new Date(Date.now() - THROTTLE_MINUTES * 60_000).toISOString();
    const { data: recent } = await supabase
      .from('lead_events')
      .select('id')
      .eq('lead_id', input.leadId)
      .eq('event_type', 'telegram_inbound_alert')
      .gte('created_at', since)
      .limit(1);
    if (recent && recent.length > 0) return;

    const snippet = (input.snippet ?? '').trim().slice(0, 80);
    const result = await notifyOperator(supabase, {
      kind: 'inbound_human_owned',
      dedupeKey: `inbound_human:${input.leadId}`,
      throttleMinutes: THROTTLE_MINUTES,
      severity: 'warn',
      title: 'לקוח כתב — ליד בטיפול אנושי ממתין למענה',
      lines: [
        `${input.leadName || 'ליד ללא שם'}${input.phone ? ` · ${input.phone}` : ''}`,
        ...(snippet ? [`"${snippet}"`] : []),
      ],
      link: `${APP_BASE_URL}/leads/${input.leadId}`,
      correlationId: input.correlationId,
    });
    if (result.delivered) {
      await logLeadEvent(supabase, input.leadId, 'telegram_inbound_alert', 'system', {
        correlation_id: input.correlationId,
      });
    }
  } catch (err) {
    log.warn('inbound_alert_failed', {
      fn: 'inbound-alert',
      correlationId: input.correlationId,
      leadId: input.leadId,
      err: String(err),
    });
  }
}

/**
 * Fires when an inbound message opens a fresh 24-hour WhatsApp window.
 *
 * `previousInboundAt` must be the lead's last_inbound_at as it stood BEFORE
 * this message landed — the caller reads the lead row before inserting, and
 * the timestamp trigger updates it after.
 *
 * Deliberately not gated on ownership: the owner wants to know that a
 * customer re-engaged even when the bot is handling the reply, because the
 * window is what expires, not the conversation. Deliberately not gated on
 * `notifications.perInboundTelegram` either — that flag governs the
 * human-owned ping above, and this alert is the one that must not be off by
 * default.
 */
export async function alertInboundWindowOpened(
  supabase: SupabaseClient,
  input: {
    leadId: string;
    leadName?: string | null;
    phone?: string | null;
    snippet?: string | null;
    channel?: string;
    ownershipMode?: string | null;
    previousInboundAt?: string | null;
    correlationId: string;
  },
): Promise<void> {
  try {
    if (!isWindowOpening(input.previousInboundAt)) return;

    const snippet = (input.snippet ?? '').trim().slice(0, 120);
    const owner = input.ownershipMode === 'ai_active' ? 'הבוט עונה' : 'בטיפול אנושי';
    const closedFor = input.previousInboundAt
      ? `נסגר מאז ${new Date(input.previousInboundAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`
      : 'פנייה ראשונה מהליד';

    await notifyOperator(supabase, {
      kind: 'inbound_window_opened',
      // One alert per lead per window. A customer sending five messages in a
      // row opens one window, so it is one alert.
      dedupeKey: `window:${input.leadId}`,
      throttleMinutes: WINDOW_HOURS * 60,
      severity: 'warn',
      title: '🟢 נפתח חלון 24 שעות — לקוח כתב לבוט',
      lines: [
        `${input.leadName || 'ליד ללא שם'}${input.phone ? ` · ${input.phone}` : ''}`,
        `${input.channel ?? 'whatsapp'} · ${owner} · ${closedFor}`,
        ...(snippet ? [`"${snippet}"`] : []),
        'אפשר להשיב בטקסט חופשי במשך 24 השעות הקרובות.',
      ],
      link: `${APP_BASE_URL}/leads/${input.leadId}`,
      correlationId: input.correlationId,
    });
  } catch (err) {
    log.warn('inbound_window_alert_failed', {
      fn: 'inbound-alert',
      correlationId: input.correlationId,
      leadId: input.leadId,
      err: String(err),
    });
  }
}

export function isWindowOpening(previousInboundAt: string | null | undefined, now = Date.now()): boolean {
  if (!previousInboundAt) return true;
  const previous = Date.parse(previousInboundAt);
  // An unparseable timestamp is treated as "no previous inbound" — better a
  // spurious alert than a missed window.
  if (!Number.isFinite(previous)) return true;
  return now - previous >= WINDOW_HOURS * 3600 * 1000;
}
