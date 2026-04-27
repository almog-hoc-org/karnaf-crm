import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface EnsureLeadInput {
  phone: string;
  senderName?: string | null;
  source: string;
  intakeChannel: string;
}

export async function ensureLeadForPhone(supabase: SupabaseClient, input: EnsureLeadInput) {
  const { data: existingLead, error: existingError } = await supabase
    .from('leads')
    .select('id, full_name, lead_status, lead_heat, ownership_mode, do_not_contact, removed_by_request, phone, source')
    .eq('phone', input.phone)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existingLead) return existingLead;

  const { data: createdLead, error: createdError } = await supabase
    .from('leads')
    .insert({
      phone: input.phone,
      full_name: input.senderName || 'ליד מוואטסאפ',
      source: input.source,
      intake_channel: input.intakeChannel,
      lead_status: 'new',
      lead_heat: 'cool',
      ownership_mode: 'ai_active',
    })
    .select('id, full_name, lead_status, lead_heat, ownership_mode, do_not_contact, removed_by_request, phone, source')
    .single();

  if (createdError) throw createdError;

  await supabase.from('lead_events').insert({
    lead_id: createdLead.id,
    event_type: 'lead_created',
    actor_type: 'system',
    event_payload: {
      source: input.source,
      intake_channel: input.intakeChannel,
    },
  });

  return createdLead;
}

export async function ensureConversation(supabase: SupabaseClient, leadId: string, channel: string, providerName: string) {
  const { data: existingConversation, error: existingError } = await supabase
    .from('conversations')
    .select('id, ownership_mode')
    .eq('lead_id', leadId)
    .eq('channel', channel)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existingConversation) return existingConversation;

  const { data: createdConversation, error: createdError } = await supabase
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

  if (createdError) throw createdError;
  return createdConversation;
}

export async function logLeadEvent(
  supabase: SupabaseClient,
  leadId: string,
  eventType: string,
  actorType: string,
  eventPayload: Record<string, unknown>,
  conversationId?: string,
) {
  const { error } = await supabase.from('lead_events').insert({
    lead_id: leadId,
    conversation_id: conversationId || null,
    event_type: eventType,
    actor_type: actorType,
    event_payload: eventPayload,
  });

  if (error) throw error;
}

export async function updateLeadTimestamps(
  supabase: SupabaseClient,
  leadId: string,
  updates: Record<string, unknown>,
) {
  const { error } = await supabase.from('leads').update({
    ...updates,
    updated_at: new Date().toISOString(),
  }).eq('id', leadId);

  if (error) throw error;
}
