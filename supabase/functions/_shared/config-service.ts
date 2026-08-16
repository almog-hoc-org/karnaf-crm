import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { AiRuntimeConfig } from './ai-contract.ts';
import { DEFAULT_SAFETY_NET, resolveSafetyNet, type SafetyNetConfig } from './generic-ack.ts';

export interface RuntimeConfig extends AiRuntimeConfig {
  slaThresholds: {
    firstResponseWarnHours: number;
    firstResponseHighWarnHours: number;
    firstResponseBreachHours: number;
    paymentPendingHours: number;
  };
  whatsappSession: {
    freeformWindowHours: number;
    fallbackTemplateName: string;
  };
  reengagement: {
    // OFF until an approved Meta template exists (24h-window sends require it).
    enabled: boolean;
    checkinDays: number;
    reactivationDays: number;
    templateName: string;
  };
  safetyNet: SafetyNetConfig;
  // Emergency kill switch. The AI answers only on the channels listed
  // here; an empty array silences the bot everywhere while humans keep
  // working the inbox. Documented in docs/runbooks/ai-quota-exhausted.md,
  // which pointed at a config key nothing actually read until now.
  aiEnabledChannels: string[];
  notifications: {
    // Telegram alert the moment a human-owned lead writes (throttled
    // per-lead). Seeded ON in migration 117; the operator can flip the
    // crm_config row off.
    perInboundTelegram: boolean;
  };
}

const DEFAULT: RuntimeConfig = {
  activeHours: { start: '09:00', end: '21:00', timezone: 'Asia/Jerusalem' },
  followUpDelays: { firstResponseMinutes: 30, nurtureHours: 24, paymentPendingHours: 12 },
  slaThresholds: {
    firstResponseWarnHours: 8,
    firstResponseHighWarnHours: 10,
    firstResponseBreachHours: 12,
    paymentPendingHours: 24,
  },
  product: { code: 'derech_le_dira', displayName: 'הדרך לדירה', priceMinIls: 3500, priceTypicalIls: 4500 },
  forbiddenClaims: [
    'תשואה מובטחת', 'מבטיח רווח', 'מובטח שתחסכו', 'מובטח שתצליחו',
    'guaranteed return', 'guaranteed savings',
  ],
  ai: { model: 'gpt-4o-mini', promptVersion: 'v1', maxReplyChars: 900 },
  whatsappSession: { freeformWindowHours: 24, fallbackTemplateName: 'karnaf_followup_v1' },
  reengagement: { enabled: false, checkinDays: 7, reactivationDays: 60, templateName: '' },
  safetyNet: DEFAULT_SAFETY_NET,
  aiEnabledChannels: ['whatsapp', 'instagram'],
  notifications: { perInboundTelegram: false },
};

export async function getRuntimeConfig(supabase: SupabaseClient): Promise<RuntimeConfig> {
  const { data, error } = await supabase.from('crm_config').select('config_key, config_value');
  if (error || !data) return DEFAULT;

  const map = new Map<string, unknown>();
  for (const row of data) map.set(row.config_key as string, row.config_value);

  const get = <T>(key: string, fallback: T): T => (map.get(key) as T) ?? fallback;

  return {
    activeHours: get('active_hours', DEFAULT.activeHours),
    followUpDelays: get('follow_up_delays', DEFAULT.followUpDelays),
    slaThresholds: get('sla_thresholds', DEFAULT.slaThresholds),
    notifications: get('notifications', DEFAULT.notifications),
    product: get('product', DEFAULT.product),
    forbiddenClaims: get('forbidden_claims', DEFAULT.forbiddenClaims),
    ai: get('ai_runtime', DEFAULT.ai),
    whatsappSession: get('whatsapp_session', DEFAULT.whatsappSession),
    reengagement: get('reengagement', DEFAULT.reengagement),
    safetyNet: resolveSafetyNet(map.get('ai_safety_net')),
    aiEnabledChannels: resolveEnabledChannels(map.get('ai_enabled_channels')),
  };
}

// An absent or malformed key means "no restriction configured" — the AI
// keeps working. Only a well-formed array (including an empty one, which
// is the kill switch) narrows the channels.
export function resolveEnabledChannels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return DEFAULT.aiEnabledChannels;
  const channels = raw.filter((c): c is string => typeof c === 'string').map((c) => c.trim().toLowerCase());
  if (channels.length !== raw.length) return DEFAULT.aiEnabledChannels;
  return channels;
}
