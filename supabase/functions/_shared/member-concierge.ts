// Deterministic concierge for program members ("הדרך לדירה").
// Members never reach the LLM: first message of a service episode gets
// the John-referral welcome; the word "מומחה" (or an explicit human
// request) hands off to a human with a 24h SLA; continued chatter gets
// one reminder per episode, then silence — the conversation waits in
// the rep's inbox.
//
// Pure decision logic is mirrored in lib/runtime/member-concierge.ts
// (unit-tested there). Keep in sync.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { logLeadEvent, transitionLeadStatus, updateLeadFields, type LeadRow } from './lead-service.ts';
import { ensurePendingQueueItem } from './queue-service.ts';
import { sendWhatsAppText } from './whatsapp-provider.ts';
import { notifyTelegram } from './notify-telegram.ts';
import { canTransition } from './state-machine.ts';
import { log } from './logger.ts';

export type ConciergeAction = 'expert' | 'greet' | 'reprompt' | 'silent';

// Exact-token matches (single words) — matched against Hebrew-letter
// tokens so 'נציג' doesn't fire inside a longer word.
const EXPERT_WORDS = new Set(['מומחה', 'נציג', 'בנאדם', 'אנושי']);

// Substring matches (phrases).
const EXPERT_PHRASES = ['בן אדם', 'אדם אמיתי', 'לדבר עם מישהו', 'שירות לקוחות', 'רוצה לדבר עם'];

export function detectExpertRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text.trim();
  if (!normalized) return false;
  const tokens = normalized.split(/[^֐-׿]+/).filter(Boolean);
  if (tokens.some((t) => EXPERT_WORDS.has(t))) return true;
  return EXPERT_PHRASES.some((p) => normalized.includes(p));
}

export interface ConciergeDecisionInput {
  text: string | null;
  /** lead.last_inbound_at as read BEFORE the current message was inserted — i.e. the previous inbound. */
  prevInboundAt: string | null;
  lastGreetedAt: string | null;
  lastRepromptedAt: string | null;
  episodeGapHours: number;
  now: Date;
}

export function decideConciergeAction(input: ConciergeDecisionInput): ConciergeAction {
  if (detectExpertRequest(input.text)) return 'expert';

  const gapMs = Math.max(1, input.episodeGapHours) * 3600 * 1000;
  const nowMs = input.now.getTime();
  const prevMs = input.prevInboundAt ? Date.parse(input.prevInboundAt) : NaN;
  const greetedMs = input.lastGreetedAt ? Date.parse(input.lastGreetedAt) : NaN;
  const repromptedMs = input.lastRepromptedAt ? Date.parse(input.lastRepromptedAt) : NaN;

  // New episode: first-ever message, or silence longer than the gap.
  const isNewEpisode = !Number.isFinite(prevMs) || nowMs - prevMs > gapMs;
  if (isNewEpisode) return 'greet';

  // Continuing episode that somehow never got a greeting (e.g. member
  // marked mid-conversation, or greeting is older than the gap).
  if (!Number.isFinite(greetedMs) || nowMs - greetedMs > gapMs) return 'greet';

  // One reminder per episode: reprompt only if we haven't since the greet.
  if (!Number.isFinite(repromptedMs) || repromptedMs < greetedMs) return 'reprompt';

  return 'silent';
}

// Fallback texts when the message_templates rows are missing — the
// concierge must never go silent because a template was deleted.
export const CONCIERGE_FALLBACK_TEXTS: Record<'member_welcome_v1' | 'member_reprompt_v1' | 'member_expert_ack_v1', string> = {
  member_welcome_v1:
    'היי {{first_name}}, כאן צוות קרנף נדל"ן 🦏\nלשאלות ידע ותוכן מהתוכנית — דברו עם ג\'ון, הסוכן הדיגיטלי החכם שלנו, בוואטסאפ {{john_phone}} (לחברי התוכנית בלבד!).\nאם ג\'ון לא סיפק מענה או שיש שאלה נוספת — כתבו כאן "מומחה" ונחזור אליכם תוך 24 שעות לכל היותר.',
  member_reprompt_v1:
    'רק מזכירים 🙂 לשאלות תוכן — ג\'ון בוואטסאפ {{john_phone}}. לכל דבר אחר כתבו "מומחה" ומומחה אנושי יחזור אליכם תוך 24 שעות.',
  member_expert_ack_v1: 'קיבלנו! מומחה מהצוות יחזור אליכם תוך 24 שעות לכל היותר 🙏',
};

export function renderConciergeText(
  body: string,
  vars: { firstName?: string | null; johnPhone?: string | null },
): string {
  return body
    .replaceAll('{{first_name}}', (vars.firstName ?? '').trim() || 'חבר/ת התוכנית')
    .replaceAll('{{john_phone}}', vars.johnPhone ?? '');
}

// ── IO wrapper ────────────────────────────────────────────────────────

export interface MemberConciergeConfig {
  enabled: boolean;
  johnPhone: string;
  episodeGapHours: number;
  expertSlaHours: number;
}

const DEFAULT_CONFIG: MemberConciergeConfig = {
  enabled: true,
  johnPhone: '',
  episodeGapHours: 6,
  expertSlaHours: 24,
};

export async function getMemberConciergeConfig(supabase: SupabaseClient): Promise<MemberConciergeConfig> {
  const { data } = await supabase
    .from('crm_config')
    .select('config_value')
    .eq('config_key', 'member_concierge')
    .maybeSingle();
  const v = (data?.config_value ?? {}) as Record<string, unknown>;
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_CONFIG.enabled,
    johnPhone: typeof v.john_phone === 'string' ? v.john_phone : DEFAULT_CONFIG.johnPhone,
    episodeGapHours: Number.isFinite(Number(v.episode_gap_hours)) && Number(v.episode_gap_hours) > 0
      ? Number(v.episode_gap_hours)
      : DEFAULT_CONFIG.episodeGapHours,
    expertSlaHours: Number.isFinite(Number(v.expert_sla_hours)) && Number(v.expert_sla_hours) > 0
      ? Number(v.expert_sla_hours)
      : DEFAULT_CONFIG.expertSlaHours,
  };
}

export interface MemberRow {
  lead_id: string;
  concierge_last_greeted_at: string | null;
  concierge_last_reprompted_at: string | null;
}

export interface HandleMemberConciergeInput {
  lead: LeadRow;
  member: MemberRow;
  conversationId: string;
  phone: string;
  text: string | null;
  /** lead.last_inbound_at as read before the current message insert. */
  prevInboundAt: string | null;
  correlationId: string;
}

export interface HandleMemberConciergeResult {
  handled: boolean;
  action: ConciergeAction | 'disabled';
}

async function fetchTemplateBody(
  supabase: SupabaseClient,
  key: keyof typeof CONCIERGE_FALLBACK_TEXTS,
): Promise<string> {
  const { data } = await supabase
    .from('message_templates')
    .select('body')
    .eq('key', key)
    .eq('channel', 'whatsapp')
    .eq('status', 'active')
    .maybeSingle();
  return (data?.body as string | undefined) || CONCIERGE_FALLBACK_TEXTS[key];
}

async function sendConciergeMessage(
  supabase: SupabaseClient,
  input: HandleMemberConciergeInput,
  text: string,
): Promise<void> {
  const result = await sendWhatsAppText(input.phone, text);
  await supabase.from('messages').insert({
    conversation_id: input.conversationId,
    lead_id: input.lead.id,
    provider_message_id: result.providerMessageId ?? null,
    sender_type: 'system',
    sender_name: 'קרנף שירות',
    direction: 'outbound',
    message_type: 'text',
    content_text: text,
    provider_status: result.ok ? 'sent' : 'failed',
    provider_error: result.ok ? null : result.error ?? 'send failed',
    raw_payload: { source: 'member_concierge', correlation_id: input.correlationId },
  });
  if (!result.ok) {
    log.error('member_concierge_send_failed', {
      fn: 'member-concierge', correlationId: input.correlationId, leadId: input.lead.id, err: result.error ?? null,
    });
  }
}

export async function handleMemberConcierge(
  supabase: SupabaseClient,
  input: HandleMemberConciergeInput,
  config: MemberConciergeConfig,
): Promise<HandleMemberConciergeResult> {
  if (!config.enabled) return { handled: false, action: 'disabled' };

  const firstName = (input.lead.full_name ?? '').split(/\s+/)[0] ?? null;
  const action = decideConciergeAction({
    text: input.text,
    prevInboundAt: input.prevInboundAt,
    lastGreetedAt: input.member.concierge_last_greeted_at,
    lastRepromptedAt: input.member.concierge_last_reprompted_at,
    episodeGapHours: config.episodeGapHours,
    now: new Date(),
  });

  if (action === 'expert') {
    const ack = await fetchTemplateBody(supabase, 'member_expert_ack_v1');
    await sendConciergeMessage(supabase, input, renderConciergeText(ack, { firstName, johnPhone: config.johnPhone }));
    await updateLeadFields(supabase, input.lead.id, { ownership_mode: 'mia_active' });
    if (canTransition(input.lead.lead_status, 'human_handoff')) {
      await transitionLeadStatus(supabase, input.lead.id, 'human_handoff', 'system', 'member_expert_requested');
    }
    await ensurePendingQueueItem(supabase, {
      leadId: input.lead.id,
      queueType: 'human_handoff',
      priorityLevel: 1,
      reason: `חבר תוכנית ביקש מומחה — לחזור תוך ${config.expertSlaHours} שעות`,
      dueAt: new Date(Date.now() + config.expertSlaHours * 3600 * 1000).toISOString(),
      payloadJson: { source: 'member_concierge', correlation_id: input.correlationId },
      createdByActorType: 'system',
    });
    await logLeadEvent(supabase, input.lead.id, 'member_expert_requested', 'system', {
      correlation_id: input.correlationId,
    }, input.conversationId);
    await notifyTelegram({
      source: 'member-concierge',
      severity: 'warn',
      title: 'חבר תוכנית מבקש מומחה',
      lines: [
        `ליד: ${input.lead.full_name ?? input.phone}`,
        `SLA: ${config.expertSlaHours} שעות`,
      ],
      correlationId: input.correlationId,
    });
    return { handled: true, action };
  }

  if (action === 'greet' || action === 'reprompt') {
    const key = action === 'greet' ? 'member_welcome_v1' : 'member_reprompt_v1';
    const body = await fetchTemplateBody(supabase, key);
    await sendConciergeMessage(supabase, input, renderConciergeText(body, { firstName, johnPhone: config.johnPhone }));
    const stampField = action === 'greet' ? 'concierge_last_greeted_at' : 'concierge_last_reprompted_at';
    await supabase.from('program_members').update({
      [stampField]: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('lead_id', input.lead.id);
    await logLeadEvent(
      supabase,
      input.lead.id,
      action === 'greet' ? 'member_concierge_greeted' : 'member_concierge_reprompted',
      'system',
      { correlation_id: input.correlationId },
      input.conversationId,
    );
    return { handled: true, action };
  }

  // silent — no send, no event; the message stays visible via the
  // mia_reply lane / inbox as usual.
  return { handled: true, action };
}
