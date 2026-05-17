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
  watiToken: () => optional('WATI_TOKEN'),
  watiApiUrl: () => optional('WATI_API_URL', 'https://live-mt-server.wati.io'),
  paymentWebhookSecret: () => optional('PAYMENT_WEBHOOK_SECRET'),
  intakeWebhookSecret: () => optional('INTAKE_WEBHOOK_SECRET'),
  slaWorkerSecret: () => optional('SLA_WORKER_SECRET'),
  outboundDispatchSecret: () => optional('OUTBOUND_DISPATCH_SECRET'),
  openaiApiKey: () => optional('OPENAI_API_KEY'),
  openaiModel: () => optional('OPENAI_MODEL', 'gpt-4o-mini'),
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
