// "Is Meta delivering customer messages to us?" — asked of Meta itself.
//
// Inbound WhatsApp needs no Meta token (only the HMAC), so a lapsed
// subscription, or a per-number webhook override pointing somewhere else,
// looks exactly like "no customer wrote". On 28.9 the CRM had received
// nothing but delivery receipts for 21 days. This reads, with the token
// already in the secrets (never echoed back):
//   - the phone number: name, quality, platform and — the key field —
//     `webhook_configuration`, which shows where Meta sends this number's
//     events (a per-number override wins over the app's callback URL);
//   - the WABA's subscribed apps (empty = the app is not subscribed and
//     Meta delivers nothing, silently).
// Used by meta-template-status (action 'subscription') and
// whatsapp-channel-status (GET).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { env } from './env.ts';

export const GRAPH_VERSION = 'v21.0';

function safeJson(text: string): unknown {
  try { return JSON.parse(text || '{}'); } catch { return { raw: text.slice(0, 400) }; }
}

/** WHATSAPP_WABA_ID → crm_config 'whatsapp_waba_id' → phone-number lookup. */
export async function resolveWabaId(supabase: SupabaseClient): Promise<{ wabaId: string; error?: string }> {
  const pinned = env.whatsappWabaId();
  if (pinned) return { wabaId: pinned };
  const { data: cfgRow } = await supabase
    .from('crm_config').select('config_value').eq('config_key', 'whatsapp_waba_id').maybeSingle();
  const cfg = cfgRow?.config_value;
  const fromCfg = (typeof cfg === 'string' ? cfg : (cfg as { id?: string } | null)?.id) ?? '';
  if (fromCfg) return { wabaId: fromCfg };
  const token = env.whatsappToken();
  const phoneId = env.whatsappPhoneId();
  if (!token || !phoneId) return { wabaId: '', error: 'WHATSAPP_TOKEN / WHATSAPP_PHONE_ID missing' };
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}?fields=whatsapp_business_account`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const text = await res.text();
  if (!res.ok) return { wabaId: '', error: `${res.status}: ${text.slice(0, 200)}` };
  const id = (safeJson(text) as { whatsapp_business_account?: { id?: string } }).whatsapp_business_account?.id ?? '';
  return id ? { wabaId: id } : { wabaId: '', error: 'phone number has no WABA' };
}

export type SubscriptionVerdict =
  | 'not_configured'
  | 'token_or_permission_problem'
  | 'app_not_subscribed_to_waba'
  | 'number_webhook_overridden'
  | 'subscription_present';

export interface WhatsAppDiagnosis {
  wabaId: string;
  subscribedApps: { ok: boolean; status: number; body: unknown };
  phoneNumber: { ok: boolean; status: number; body: unknown };
  /** Callback URL Meta uses for this number, when the number overrides the app's. */
  numberWebhookOverride: string | null;
  verdict: SubscriptionVerdict;
}

export async function diagnoseWhatsAppSubscription(wabaId: string): Promise<WhatsAppDiagnosis> {
  const token = env.whatsappToken();
  const phoneId = env.whatsappPhoneId();
  const empty = { ok: false, status: 0, body: null };
  if (!token || !phoneId || !wabaId) {
    return { wabaId, subscribedApps: empty, phoneNumber: empty, numberWebhookOverride: null, verdict: 'not_configured' };
  }
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  const subsRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/subscribed_apps`, auth);
  const subsText = await subsRes.text();
  const subscribedApps = { ok: subsRes.ok, status: subsRes.status, body: safeJson(subsText) };

  const fields = 'id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,throughput,webhook_configuration';
  const phoneRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}?fields=${fields}`, auth);
  const phoneText = await phoneRes.text();
  const phoneNumber = { ok: phoneRes.ok, status: phoneRes.status, body: safeJson(phoneText) };

  const webhookCfg = (phoneNumber.body as { webhook_configuration?: Record<string, unknown> } | null)?.webhook_configuration;
  // Meta reports the number-level override as `phone_number`; `application`
  // is the app-level URL. An override that is not our function means
  // customer messages for this number go elsewhere.
  const override = typeof webhookCfg?.phone_number === 'string' ? webhookCfg.phone_number : null;
  const ourHost = new URL(env.supabaseUrl()).host;
  const overriddenAway = !!override && !override.includes(ourHost);

  const apps = (subscribedApps.body as { data?: unknown[] } | null)?.data;
  const verdict: SubscriptionVerdict = !subsRes.ok || !phoneRes.ok
    ? 'token_or_permission_problem'
    : Array.isArray(apps) && apps.length === 0
      ? 'app_not_subscribed_to_waba'
      : overriddenAway
        ? 'number_webhook_overridden'
        : 'subscription_present';

  return { wabaId, subscribedApps, phoneNumber, numberWebhookOverride: override, verdict };
}
