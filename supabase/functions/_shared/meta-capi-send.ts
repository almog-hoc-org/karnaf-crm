// IO half of the Meta Conversions API integration (Deno-only, not
// mirrored). Silent no-op when META_PIXEL_ID / META_CAPI_TOKEN are not
// provisioned — the feature is off until the operator sets both.
//
// Callers treat this as fire-and-forget: one attempt, warn on failure,
// never throw. A dropped conversion event must never break an intake
// response or a payment ack. Never log the token, PII, or hashes.

import { env } from './env.ts';
import { log } from './logger.ts';

export async function sendCapiEvents(
  events: Array<Record<string, unknown>>,
  correlationId: string,
): Promise<void> {
  const pixelId = env.metaPixelId();
  const token = env.metaCapiToken();
  if (!pixelId || !token || events.length === 0) return;

  try {
    const body: Record<string, unknown> = { data: events, access_token: token };
    const testCode = env.metaCapiTestEventCode();
    if (testCode) body.test_event_code = testCode;

    const res = await fetch(
      `https://graph.facebook.com/${env.metaGraphVersion()}/${pixelId}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300);
      log.warn('capi_send_failed', {
        fn: 'meta-capi-send',
        correlationId,
        status: res.status,
        // Graph error body carries no PII for events payloads.
        err: errText.replaceAll(token, '***'),
      });
      return;
    }
    const result = (await res.json()) as { events_received?: number };
    log.info('capi_events_sent', {
      fn: 'meta-capi-send',
      correlationId,
      eventsReceived: result.events_received ?? events.length,
    });
  } catch (err) {
    log.warn('capi_send_failed', { fn: 'meta-capi-send', correlationId, err: String(err) });
  }
}
