export interface NormalizedInboundMessage {
  provider: string;
  providerMessageId: string | null;
  phone: string;
  senderName: string | null;
  text: string | null;
  messageType: 'text' | 'media' | 'unknown';
  mediaType?: string | null;
  rawPayload: Record<string, unknown>;
  receivedAt: string;
}

export interface OutboundSendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface TemplateParam {
  name: string;
  value: string;
}

export interface WhatsAppProviderAdapter {
  readonly providerName: string;
  normalizeInbound(payload: Record<string, unknown>): NormalizedInboundMessage | null;
  sendText(to: string, text: string): Promise<OutboundSendResult>;
  sendTemplate(to: string, templateName: string, params?: TemplateParam[]): Promise<OutboundSendResult>;
}
