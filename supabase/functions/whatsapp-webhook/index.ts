import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { normalizeIsraeliPhone } from '../_shared/phone.ts';
import { normalizeProviderInbound } from '../_shared/whatsapp-provider.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensureConversation, ensureLeadForPhone, logLeadEvent, updateLeadTimestamps } from '../_shared/lead-service.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VERIFY_TOKEN = Deno.env.get('WHATSAPP_VERIFY_TOKEN') || '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return new Response(challenge ?? '', { status: 200, headers: corsHeaders });
    }

    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const body = await req.json();
  const normalized = normalizeProviderInbound(body);

  if (!normalized) {
    return jsonResponse({ ok: true, skipped: true, reason: 'Unsupported payload' });
  }

  const phone = normalizeIsraeliPhone(normalized.phone) || normalized.phone;
  const supabase = getServiceSupabase();

  const lead = await ensureLeadForPhone(supabase, {
    phone,
    senderName: normalized.senderName,
    source: 'whatsapp',
    intakeChannel: 'whatsapp',
  });
  const leadId = lead.id as string;

  const conversation = await ensureConversation(supabase, leadId, 'whatsapp', normalized.provider);
  const conversationId = conversation.id as string;

  await supabase.from('messages').insert({
    conversation_id: conversationId,
    lead_id: leadId,
    provider_message_id: normalized.providerMessageId,
    sender_type: 'lead',
    sender_name: normalized.senderName,
    direction: 'inbound',
    message_type: normalized.messageType,
    content_text: normalized.text,
    media_type: normalized.mediaType || null,
    created_at: normalized.receivedAt,
    raw_payload: normalized.rawPayload,
  });

  await logLeadEvent(supabase, leadId, 'inbound_message_received', 'provider', {
    provider: normalized.provider,
    provider_message_id: normalized.providerMessageId,
  }, conversationId);

  await updateLeadTimestamps(supabase, leadId, {
    last_message_at: normalized.receivedAt,
    last_inbound_at: normalized.receivedAt,
  });

  const orchestrateRes = await fetch(`${SUPABASE_URL}/functions/v1/orchestrate-message`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      leadId,
      conversationId,
      provider: normalized.provider,
      providerMessageId: normalized.providerMessageId,
    }),
  });

  const orchestrateJson = await orchestrateRes.json().catch(() => null);

  return jsonResponse({
    ok: true,
    leadId,
    conversationId,
    orchestrator: orchestrateJson,
  });
});
