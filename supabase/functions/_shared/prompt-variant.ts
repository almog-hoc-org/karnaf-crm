// Pulls a weighted prompt variant for the active playbook from the
// `prompt_variants` table. The `prompt_overrides` jsonb supports two
// keys today:
//   - "objective": replaces the playbook objective in the system prompt
//   - "guidance":  string[] that replaces the playbook guidance bullets
// Future fields are forwarded verbatim into the prompt builder so we can
// extend the schema without a code release.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.117.2';

export interface PromptVariant {
  version: string;
  weight: number;
  prompt_overrides: PromptOverrides;
}

export interface PromptOverrides {
  objective?: string;
  guidance?: string[];
  [key: string]: unknown;
}

export interface LeadSegment {
  heat?: string | null;
  source?: string | null;
  status?: string | null;
}

export async function pickPromptVariant(
  supabase: SupabaseClient,
  playbookName: string,
  segment: LeadSegment = {},
): Promise<PromptVariant | null> {
  const { data, error } = await supabase.rpc('pick_prompt_variant', {
    p_playbook: playbookName,
    p_lead_heat: segment.heat ?? null,
    p_lead_source: segment.source ?? null,
    p_lead_status: segment.status ?? null,
  });
  if (error || !data) return null;
  if (Array.isArray(data) && data.length > 0) return data[0] as PromptVariant;
  if (!Array.isArray(data) && typeof data === 'object') return data as PromptVariant;
  return null;
}
