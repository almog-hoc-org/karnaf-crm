// Tier 8.E1 — channel-aware outbound text sender.
//
// Single switch over conversation channels so callers (dispatch-outbound
// template sends, orchestrate-message, send-reply) don't hardcode
// WhatsApp. Instagram lands in Tier 8.A as a second case; adding a
// channel here is the only change senders need.

import type { OutboundSendResult } from './provider-types.ts';
import { sendWhatsAppText } from './whatsapp-provider.ts';

export interface ChannelLead {
  phone?: string | null;
  ig_user_id?: string | null;
}

export async function sendChannelText(
  channel: string,
  lead: ChannelLead,
  text: string,
): Promise<OutboundSendResult> {
  switch (channel) {
    case 'whatsapp': {
      if (!lead.phone) return { ok: false, error: 'lead has no phone' };
      return await sendWhatsAppText(lead.phone, text);
    }
    default:
      return { ok: false, error: `unsupported channel: ${channel}` };
  }
}
