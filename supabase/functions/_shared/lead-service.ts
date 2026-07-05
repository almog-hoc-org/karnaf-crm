import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface UpsertLeadInput {
  phone: string;
  senderName?: string | null;
  source: string;
  intakeChannel: string;
  metadata?: Record<string, unknown>;
}

export interface LeadRow {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  source: string;
  lead_status: string;
  lead_heat: string;
  lead_score: number;
  ownership_mode: string;
  payment_status: string | null;
  do_not_contact: boolean;
  removed_by_request: boolean;
  conversation_summary: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  [key: string]: unknown;
}

export async function upsertLeadByPhone(
  supabase: SupabaseClient,
  input: UpsertLeadInput,
): Promise<LeadRow> {
  const { data, error } = await supabase.rpc('upsert_lead_by_phone', {
    p_phone: input.phone,
    p_full_name: input.senderName ?? null,
    p_source: input.source,
    p_intake_channel: input.intakeChannel,
    p_metadata: input.metadata ?? {},
  });

  if (error) throw error;
  if (Array.isArray(data)) return (data[0] as unknown) as LeadRow;
  return data as unknown as LeadRow;
}

export interface SmartUpsertInput {
  phone: string | null;
  email: string | null;
  fullName?: string | null;
  source: string;
  intakeChannel: string;
  metadata?: Record<string, unknown>;
}

// Phone-first identity match, email fallback, then create. Backed by the
// upsert_lead_smart RPC.
export async function upsertLead(
  supabase: SupabaseClient,
  input: SmartUpsertInput,
): Promise<LeadRow> {
  const { data, error } = await supabase.rpc('upsert_lead_smart', {
    p_phone: input.phone,
    p_email: input.email,
    p_full_name: input.fullName ?? null,
    p_source: input.source,
    p_intake_channel: input.intakeChannel,
    p_metadata: input.metadata ?? {},
  });
  if (error) throw error;
  if (Array.isArray(data)) return (data[0] as unknown) as LeadRow;
  return data as unknown as LeadRow;
}

export async function ensureConversation(
  supabase: SupabaseClient,
  leadId: string,
  channel: string,
  providerName: string,
): Promise<{ id: string; ownership_mode: string }> {
  const { data: existing, error: existingErr } = await supabase
    .from('conversations')
    .select('id, ownership_mode')
    .eq('lead_id', leadId)
    .eq('channel', channel)
    .maybeSingle();
  if (existingErr) throw existingErr;
  if (existing) return existing as { id: string; ownership_mode: string };

  const { data: created, error: createdErr } = await supabase
    .from('conversations')
    .insert({
      lead_id: leadId,
      channel,
      provider_name: providerName,
      ownership_mode: 'ai_active',
      is_open: true,
    })
    .select('id, ownership_mode')
    .single();
  if (createdErr) throw createdErr;
  return created as { id: string; ownership_mode: string };
}

export async function logLeadEvent(
  supabase: SupabaseClient,
  leadId: string,
  eventType: string,
  actorType: string,
  payload: Record<string, unknown> = {},
  conversationId?: string,
  actorId?: string,
): Promise<void> {
  const { error } = await supabase.from('lead_events').insert({
    lead_id: leadId,
    conversation_id: conversationId ?? null,
    event_type: eventType,
    actor_type: actorType,
    actor_id: actorId ?? null,
    event_payload: payload,
  });
  if (error) throw error;
}

export async function transitionLeadStatus(
  supabase: SupabaseClient,
  leadId: string,
  target: string,
  actorType: string,
  reason?: string,
): Promise<LeadRow | null> {
  const { data, error } = await supabase.rpc('transition_lead_status', {
    p_lead_id: leadId,
    p_target: target,
    p_actor_type: actorType,
    p_reason: reason ?? null,
  });
  if (error) throw error;
  if (!data) return null;
  if (Array.isArray(data)) return (data[0] as unknown) as LeadRow;
  return data as unknown as LeadRow;
}

export async function updateLeadFields(
  supabase: SupabaseClient,
  leadId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from('leads').update(updates).eq('id', leadId);
  if (error) throw error;
}
