// Centralised environment access. Throws early on missing required values
// so a misconfigured deploy fails loudly rather than silently mis-routing.

function read(name: string): string | undefined {
  const value = Deno.env.get(name);
  if (value === undefined || value === '') return undefined;
  return value;
}

export function required(name: string): string {
  const value = read(name);
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

export function optional(name: string, fallback = ''): string {
  return read(name) ?? fallback;
}

export const env = {
  supabaseUrl: () => required('SUPABASE_URL'),
  serviceRoleKey: () => required('SUPABASE_SERVICE_ROLE_KEY'),
  anonKey: () => required('SUPABASE_ANON_KEY'),
  whatsappAppSecret: () => optional('WHATSAPP_APP_SECRET'),
  whatsappVerifyToken: () => optional('WHATSAPP_VERIFY_TOKEN'),
  whatsappToken: () => optional('WHATSAPP_TOKEN'),
  whatsappPhoneId: () => optional('WHATSAPP_PHONE_ID'),
  whatsappFallbackTemplate: () => optional('WHATSAPP_FALLBACK_TEMPLATE', 'karnaf_followup_v1'),
  // WABA id for template listing/creation. The phone-number lookup path
  // fails with Graph #100 when the token cannot read the
  // whatsapp_business_account field, so allow pinning it explicitly.
  whatsappWabaId: () => optional('WHATSAPP_WABA_ID'),
  watiToken: () => optional('WATI_TOKEN'),
  watiApiUrl: () => optional('WATI_API_URL', 'https://live-mt-server.wati.io'),
  paymentWebhookSecret: () => optional('PAYMENT_WEBHOOK_SECRET'),
  /** Static-token lane for PSPs that can't sign HMAC (e.g. Grow) —
   *  rides as ?token= on the webhook URL, safelisted per provider. */
  paymentStaticToken: () => optional('PAYMENT_STATIC_TOKEN'),
  intakeWebhookSecret: () => optional('INTAKE_WEBHOOK_SECRET'),
  automationTickSecret: () => optional('AUTOMATION_TICK_SECRET'),
  /** Tier 8.B — static token lane for integrations that can't sign HMAC
   *  (Rav Messer webhooks). Token rides as ?token= on the intake URL;
   *  token-authenticated requests are restricted to a source safelist. */
  intakeStaticToken: () => optional('INTAKE_STATIC_TOKEN'),
  /** Tier 8.C — Responder (Rav Messer) REST API credentials, from
   *  support@responder.co.il. All four required for list-add calls. */
  ravmesserCKey: () => optional('RAVMESSER_C_KEY'),
  ravmesserCSecret: () => optional('RAVMESSER_C_SECRET'),
  ravmesserUKey: () => optional('RAVMESSER_U_KEY'),
  ravmesserUSecret: () => optional('RAVMESSER_U_SECRET'),
  slaWorkerSecret: () => optional('SLA_WORKER_SECRET'),
  outboundDispatchSecret: () => optional('OUTBOUND_DISPATCH_SECRET'),
  // Falls back to the outbound dispatch secret so the broadcast worker
  // needs no extra provisioning — the cron caller applies the same
  // fallback when reading from vault (migration 094).
  broadcastDispatchSecret: () =>
    optional('BROADCAST_DISPATCH_SECRET') || optional('OUTBOUND_DISPATCH_SECRET'),
  /** Meta webhooks (FB Lead Ads + Instagram DM) — app credentials. */
  metaVerifyToken: () => optional('META_VERIFY_TOKEN'),
  metaAppSecret: () => optional('META_APP_SECRET'),
  metaGraphVersion: () => optional('META_GRAPH_VERSION', 'v21.0'),
  facebookPageAccessToken: () => optional('FACEBOOK_PAGE_ACCESS_TOKEN'),
  /** Meta Conversions API — server-side Lead/Purchase events. Both must
   *  be set for events to send; absence = feature off (silent no-op). */
  metaPixelId: () => optional('META_PIXEL_ID'),
  metaCapiToken: () => optional('META_CAPI_TOKEN'),
  /** Events Manager test-events code — set temporarily to verify wiring. */
  metaCapiTestEventCode: () => optional('META_CAPI_TEST_EVENT_CODE'),
  /** Student Portal (provision-student) — cross-project invite issuing. */
  portalBaseUrl: () => optional('PORTAL_BASE_URL'),
  portalSupabaseUrl: () => optional('PORTAL_SUPABASE_URL'),
  portalServiceRoleKey: () => optional('PORTAL_SERVICE_ROLE_KEY'),
  openaiApiKey: () => optional('OPENAI_API_KEY'),
  openaiModel: () => optional('OPENAI_MODEL', 'gpt-4o-mini'),
  aiProvider: () => optional('AI_PROVIDER', 'openai').toLowerCase(),
  geminiApiKey: () => optional('GEMINI_API_KEY'),
  geminiModel: () => optional('GEMINI_MODEL', 'gemini-1.5-flash'),
  /** Telegram bot token used by `_shared/notify-telegram.ts` for SLA /
   *  cron alerts. Silently no-ops when missing — operator opts in. */
  telegramBotToken: () => optional('TELEGRAM_BOT_TOKEN'),
  /** Chat id (positive for DM, negative for group). */
  telegramAlertChatId: () => optional('TELEGRAM_ALERT_CHAT_ID'),
};

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
