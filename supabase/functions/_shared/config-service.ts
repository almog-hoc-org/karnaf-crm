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
    product: get('product', DEFAULT.product),
    forbiddenClaims: get('forbidden_claims', DEFAULT.forbiddenClaims),
    ai: get('ai_runtime', DEFAULT.ai),
    whatsappSession: get('whatsapp_session', DEFAULT.whatsappSession),
    reengagement: get('reengagement', DEFAULT.reengagement),
    safetyNet: resolveSafetyNet(map.get('ai_safety_net')),
  };
}
