// Per-inbound operator alert (phase D of the operator-UX overhaul).
//
// When a HUMAN-owned lead writes, nobody was notified in real time —
// the aggregate sla-worker/watchdog Telegrams fire minutes later with
// counts only. This helper sends an immediate, named, deep-linked
// Telegram alert from the two chokepoints every such inbound passes
// through (orchestrate's ownership gate + the webhook's pending-reply
// flush). Config-gated (crm_config.notifications.perInboundTelegram)
// and throttled to one alert per lead per 10 minutes via the
// telegram_inbound_alert lead_event. Always best-effort: never throws.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getRuntimeConfig } from './config-service.ts';
import { logLeadEvent } from './lead-service.ts';
import { notifyTelegram } from './notify-telegram.ts';
import { log } from './logger.ts';

const THROTTLE_MINUTES = 10;
const APP_BASE_URL = 'https://karnaf-crm.vercel.app';

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
    const result = await notifyTelegram({
      source: 'inbound-alert',
      severity: 'warn',
      title: 'לקוח כתב — ליד בטיפול אנושי ממתין למענה',
      lines: [
        `${input.leadName || 'ליד ללא שם'}${input.phone ? ` · ${input.phone}` : ''}`,
        ...(snippet ? [`"${snippet}"`] : []),
      ],
      link: `${APP_BASE_URL}/leads/${input.leadId}`,
      correlationId: input.correlationId,
    });
    if (result.sent) {
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
