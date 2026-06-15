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
  /** Shared Meta App Secret for IG / FB Lead Ads webhooks. Falls back to
   *  the WhatsApp app secret since most installs use a single Meta App. */
  metaAppSecret: () => optional('META_APP_SECRET') || optional('WHATSAPP_APP_SECRET'),
  /** Shared Verify Token used by IG / FB Lead Ads webhook subscription
   *  handshakes. Falls back to the WhatsApp verify token. */
  metaVerifyToken: () => optional('META_VERIFY_TOKEN') || optional('WHATSAPP_VERIFY_TOKEN'),
  /** Page access token required to call Graph for FB Lead Ads (`leadgen_id`
   *  → field_data hydration). Without it FB leads are queued as
   *  manual_review_required with the raw payload preserved. */
  facebookPageAccessToken: () => optional('FACEBOOK_PAGE_ACCESS_TOKEN'),
  /** Graph API version for Meta calls. */
  metaGraphVersion: () => optional('META_GRAPH_VERSION', 'v23.0'),
  watiToken: () => optional('WATI_TOKEN'),
  watiApiUrl: () => optional('WATI_API_URL', 'https://live-mt-server.wati.io'),
  paymentWebhookSecret: () => optional('PAYMENT_WEBHOOK_SECRET'),
  intakeWebhookSecret: () => optional('INTAKE_WEBHOOK_SECRET'),
  slaWorkerSecret: () => optional('SLA_WORKER_SECRET'),
  openaiApiKey: () => optional('OPENAI_API_KEY'),
  openaiModel: () => optional('OPENAI_MODEL', 'gpt-4o-mini'),
  // AI provider routing. Empty → auto-pick based on which key is set
  // (OpenAI wins ties). Set explicitly to force a provider.
  aiProvider: () => optional('AI_PROVIDER'),
  // Google Gemini (https://ai.google.dev). Accepts GEMINI_API_KEY or the
  // generic GOOGLE_API_KEY for convenience.
  geminiApiKey: () => optional('GEMINI_API_KEY') || optional('GOOGLE_API_KEY'),
  geminiModel: () => optional('GEMINI_MODEL', 'gemini-2.5-flash'),
  // Groq (https://console.groq.com). OpenAI-compatible chat-completions API.
  groqApiKey: () => optional('GROQ_API_KEY'),
  groqModel: () => optional('GROQ_MODEL', 'llama-3.3-70b-versatile'),
  /** Telegram bot token used to push SLA-breach alerts. No-op when missing. */
  telegramBotToken: () => optional('TELEGRAM_BOT_TOKEN'),
  /** Chat id (positive for user, negative for group) for the SLA alerts. */
  telegramAlertChatId: () => optional('TELEGRAM_ALERT_CHAT_ID'),
  /** Student Portal Supabase project URL — destination for accept-invite calls. */
  portalSupabaseUrl: () => optional('PORTAL_SUPABASE_URL'),
  /** Service-role JWT for the Student Portal Supabase project. Required to
   *  insert into the portal's `invite_codes` table cross-project. */
  portalServiceRoleKey: () => optional('PORTAL_SERVICE_ROLE_KEY'),
  /** Public portal URL used to compose the sign-up link sent to the student
   *  (e.g. https://tools.karnaf.app). Falls back to a static placeholder. */
  portalBaseUrl: () => optional('PORTAL_BASE_URL', 'https://tools.karnaf.app'),
  /** Feature flag for auto-provisioning students from payment-webhook. Off
   *  by default — flip to "true" only after manual smoke-tests pass. */
  portalProvisionEnabled: () => optional('PORTAL_PROVISION_ENABLED') === 'true',
};

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
