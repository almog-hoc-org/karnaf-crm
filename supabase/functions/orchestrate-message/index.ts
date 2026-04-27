import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { sendWhatsAppText } from '../_shared/whatsapp-provider.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { ensurePendingQueueItem } from '../_shared/queue-service.ts';
import { logLeadEvent, updateLeadTimestamps } from '../_shared/lead-service.ts';
import { decidePlaceholderReply } from '../_shared/placeholder-brain.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const { leadId, conversationId } = await req.json();
  if (!leadId || !conversationId) {
    return jsonResponse({ error: 'Missing leadId or conversationId' }, 400);
  }

  const supabase = getServiceSupabase();

  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single();

  if (leadError || !lead) {
    return jsonResponse({ error: leadError?.message || 'Lead not found' }, 404);
  }

  const { data: recentMessages, error: messagesError } = await supabase
    .from('messages')
    .select('sender_type, content_text, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(8);

  if (messagesError) {
    return jsonResponse({ error: messagesError.message }, 500);
  }

  const lastInbound = recentMessages?.find((m) => m.sender_type === 'lead');
  const inboundText = lastInbound?.content_text || '';

  const decision = decidePlaceholderReply({
    inboundText,
    fullName: lead.full_name,
    source: lead.source,
    currentStatus: lead.lead_status,
    currentHeat: lead.lead_heat,
  });

  const sendResult = decision.replyText && !lead.do_not_contact && !lead.removed_by_request
    ? await sendWhatsAppText(lead.phone, decision.replyText)
    : { ok: false, error: 'Suppressed or no reply' };

  if (decision.replyText && sendResult.ok) {
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      lead_id: leadId,
      provider_message_id: sendResult.providerMessageId || null,
      sender_type: 'ai',
      direction: 'outbound',
      message_type: 'text',
      content_text: decision.replyText,
      provider_status: 'sent',
    });

    await logLeadEvent(supabase, leadId, 'ai_reply_sent', 'ai', {
      reply_text: decision.replyText,
      lead_status_update: decision.leadStatusUpdate,
      lead_heat_update: decision.leadHeatUpdate,
      score_delta: decision.scoreDelta,
    }, conversationId);

    const nextScore = Math.max(0, Math.min(100, Number(lead.lead_score || 0) + decision.scoreDelta));
    await updateLeadTimestamps(supabase, leadId, {
      lead_status: decision.leadStatusUpdate || lead.lead_status,
      lead_heat: decision.leadHeatUpdate || lead.lead_heat,
      lead_score: nextScore,
      last_message_at: new Date().toISOString(),
      last_outbound_at: new Date().toISOString(),
      last_ai_touch_at: new Date().toISOString(),
    });

    if (decision.createQueueType) {
      await ensurePendingQueueItem(supabase, {
        leadId,
        queueType: decision.createQueueType,
        priorityLevel: decision.escalateToPhoneSales ? 1 : 2,
        reason: decision.notesForMia || 'Escalation required',
        queueSummary: decision.replyText,
        payloadJson: {
          escalate_to_mia: decision.escalateToMia,
          escalate_to_phone_sales: decision.escalateToPhoneSales,
        },
      });
    }
  }

  return jsonResponse({
    ok: true,
    decision,
    sendResult,
    note: 'Still placeholder orchestration. Replace with structured AI runtime next.',
  });
});
