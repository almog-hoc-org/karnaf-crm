// Opt-out / re-subscribe handling. The pure parts (detection, footer,
// config resolution) are mirrored in lib/runtime/opt-out.ts for unit tests
// — keep them in sync. The database effects live only here.
//
// Israeli spam law (חוק הספאם): every marketing message must let the
// recipient remove themselves, and a removal request must stop further
// mailings. Before this module a removal request reached the AI as a
// "hint" at best: the opt_out playbook only moved lead_status, no consent
// column changed, journeys kept advancing, and a scheduled broadcast
// still went out to the person who had just written "הסר".

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { log } from './logger.ts';

export const DEFAULT_OPT_OUT_KEYWORDS = [
  'הסר', 'הסירו', 'הסירו אותי', 'תסיר', 'תסירו', 'להסיר',
  'תוריד', 'תורידו', 'להוריד אותי', 'תפסיק', 'תפסיקו',
  'לא מעוניין', 'לא מעוניינת', 'אל תפנו', 'אל תשלחו',
  'stop', 'unsubscribe', 'remove me', 'opt out',
];

export const DEFAULT_RESUBSCRIBE_KEYWORDS = ['חזור', 'הרשם', 'תרשמו אותי', 'resubscribe', 'start'];

export const DEFAULT_OPT_OUT_FOOTER = 'להסרה מרשימת התפוצה השיבו "הסר"';

export const DEFAULT_OPT_OUT_CONFIRMATION =
  'הוסרת מרשימת התפוצה שלנו ולא נשלח לך עוד הודעות שיווקיות. אם תרצה לחזור, כתוב "חזור".';

export const DEFAULT_RESUBSCRIBE_CONFIRMATION = 'חזרת לרשימת התפוצה שלנו. תודה!';

// Messages longer than this are never treated as a bare command.
const MAX_COMMAND_WORDS = 6;

export interface MessagingConfig {
  optOutKeywords: string[];
  resubscribeKeywords: string[];
  optOutFooter: string;
  optOutConfirmation: string;
  resubscribeConfirmation: string;
}

export const DEFAULT_MESSAGING: MessagingConfig = {
  optOutKeywords: DEFAULT_OPT_OUT_KEYWORDS,
  resubscribeKeywords: DEFAULT_RESUBSCRIBE_KEYWORDS,
  optOutFooter: DEFAULT_OPT_OUT_FOOTER,
  optOutConfirmation: DEFAULT_OPT_OUT_CONFIRMATION,
  resubscribeConfirmation: DEFAULT_RESUBSCRIBE_CONFIRMATION,
};

/** Fill a partial crm_config `messaging` value with defaults; tolerate junk. */
export function resolveMessaging(raw: unknown): MessagingConfig {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const strList = (v: unknown, fallback: string[]) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length > 0 ? v as string[] : fallback;
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v : fallback);
  return {
    optOutKeywords: strList(obj.optOutKeywords, DEFAULT_MESSAGING.optOutKeywords),
    resubscribeKeywords: strList(obj.resubscribeKeywords, DEFAULT_MESSAGING.resubscribeKeywords),
    optOutFooter: str(obj.optOutFooter, DEFAULT_MESSAGING.optOutFooter),
    optOutConfirmation: str(obj.optOutConfirmation, DEFAULT_MESSAGING.optOutConfirmation),
    resubscribeConfirmation: str(obj.resubscribeConfirmation, DEFAULT_MESSAGING.resubscribeConfirmation),
  };
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesKeyword(text: string, keywords: string[]): boolean {
  const norm = normalise(text);
  if (!norm) return false;
  const words = norm.split(' ');
  if (words.length > MAX_COMMAND_WORDS) return false;
  for (const raw of keywords) {
    const kw = normalise(raw);
    if (!kw) continue;
    if (norm === kw) return true;
    if ((' ' + norm + ' ').includes(' ' + kw + ' ')) return true;
  }
  return false;
}

/** True when the inbound text is a removal request. */
export function detectOptOut(text: string | null | undefined, keywords = DEFAULT_OPT_OUT_KEYWORDS): boolean {
  if (!text) return false;
  return matchesKeyword(text, keywords);
}

/** True when the inbound text asks to be put back on the list. */
export function detectResubscribe(text: string | null | undefined, keywords = DEFAULT_RESUBSCRIBE_KEYWORDS): boolean {
  if (!text) return false;
  return matchesKeyword(text, keywords);
}

/**
 * Append the opt-out line to an outgoing marketing text. Idempotent;
 * `oneLine` is for template parameters, which Meta rejects when they
 * contain newlines.
 */
export function appendOptOutFooter(
  text: string,
  footer = DEFAULT_OPT_OUT_FOOTER,
  opts: { oneLine?: boolean } = {},
): string {
  const body = text.trimEnd();
  if (!footer.trim()) return body;
  if (normalise(body).includes(normalise(footer))) return body;
  return opts.oneLine ? `${body} · ${footer}` : `${body}\n\n${footer}`;
}

// ── Database effects ──────────────────────────────────────────────────

export type OptOutBasis = 'inbound_keyword' | 'ai_playbook' | 'provider_unsubscribe' | 'manual';
export type OptOutChannel = 'whatsapp' | 'instagram' | 'email';

export interface ApplyOptOutInput {
  leadId: string;
  channel: OptOutChannel;
  basis: OptOutBasis;
  text?: string | null;
  correlationId?: string;
  conversationId?: string | null;
  actorType?: string;
  actorId?: string | null;
  /**
   * An email unsubscribe (link in a Rav Messer campaign) revokes email
   * only; a person who writes "הסר" on WhatsApp is removed from every
   * mailing. Default: both channels.
   */
  scope?: 'all' | 'email';
}

export interface ApplyOptOutResult {
  revokedChannels: string[];
  cancelledJourneys: number;
  cancelledDispatches: number;
  skippedRecipients: number;
}

/**
 * Record a removal request and stop everything already in flight for the
 * lead. Never throws for the cleanup part — a failure to cancel a journey
 * must not undo the consent change, which is the legally binding bit.
 */
export async function applyOptOut(
  supabase: SupabaseClient,
  input: ApplyOptOutInput,
): Promise<ApplyOptOutResult> {
  const scope = input.scope ?? 'all';
  const nowIso = new Date().toISOString();
  const revokedChannels = scope === 'email' ? ['email'] : ['email', 'whatsapp'];

  const updates: Record<string, unknown> = { consent_email: false, consent_updated_at: nowIso };
  if (scope === 'all') {
    updates.consent_whatsapp = false;
    // Replies to a lead who writes again are still allowed (kind: 'reply');
    // only proactive contact is blocked.
    updates.no_proactive_contact = true;
  }
  const { error } = await supabase.from('leads').update(updates).eq('id', input.leadId);
  if (error) throw error;

  await supabase.from('lead_events').insert({
    lead_id: input.leadId,
    conversation_id: input.conversationId ?? null,
    event_type: 'consent_revoked',
    actor_type: input.actorType ?? 'system',
    actor_id: input.actorId ?? null,
    event_payload: {
      channels: revokedChannels,
      channel: input.channel,
      basis: input.basis,
      text: input.text ? String(input.text).slice(0, 200) : null,
      correlation_id: input.correlationId ?? null,
    },
  });

  const result: ApplyOptOutResult = {
    revokedChannels, cancelledJourneys: 0, cancelledDispatches: 0, skippedRecipients: 0,
  };
  if (scope !== 'all') return result;

  try {
    const { data: runs } = await supabase
      .from('journey_runs')
      .update({ status: 'cancelled', cancellation_reason: 'opt_out' })
      .eq('lead_id', input.leadId)
      .eq('status', 'active')
      .select('id');
    result.cancelledJourneys = runs?.length ?? 0;
  } catch (err) {
    log.warn('opt_out_journey_cancel_failed', { fn: 'opt-out', leadId: input.leadId, err: String(err) });
  }
  try {
    const { data: rows } = await supabase
      .from('outbound_dispatch')
      .update({ status: 'failed', last_error: 'opt_out', failed_at: nowIso })
      .eq('lead_id', input.leadId)
      .in('status', ['pending', 'in_flight'])
      .eq('payload->>kind', 'template')
      .select('id');
    result.cancelledDispatches = rows?.length ?? 0;
  } catch (err) {
    log.warn('opt_out_dispatch_cancel_failed', { fn: 'opt-out', leadId: input.leadId, err: String(err) });
  }
  try {
    const { data: rows } = await supabase
      .from('broadcast_recipients')
      .update({ status: 'skipped', error: 'opt_out' })
      .eq('lead_id', input.leadId)
      .in('status', ['pending', 'enqueued'])
      .select('id');
    result.skippedRecipients = rows?.length ?? 0;
  } catch (err) {
    log.warn('opt_out_recipient_skip_failed', { fn: 'opt-out', leadId: input.leadId, err: String(err) });
  }

  log.info('opt_out_applied', { fn: 'opt-out', leadId: input.leadId, basis: input.basis, channel: input.channel, ...result });
  return result;
}

/** The lead asked to come back: both consents on, proactive contact allowed again. */
export async function applyResubscribe(
  supabase: SupabaseClient,
  input: { leadId: string; channel: OptOutChannel; text?: string | null; correlationId?: string; conversationId?: string | null },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from('leads')
    .update({ consent_email: true, consent_whatsapp: true, no_proactive_contact: false, consent_updated_at: nowIso })
    .eq('id', input.leadId);
  if (error) throw error;
  await supabase.from('lead_events').insert({
    lead_id: input.leadId,
    conversation_id: input.conversationId ?? null,
    event_type: 'consent_granted',
    actor_type: 'system',
    event_payload: {
      channels: ['email', 'whatsapp'],
      channel: input.channel,
      basis: 'inbound_request',
      text: input.text ? String(input.text).slice(0, 200) : null,
      correlation_id: input.correlationId ?? null,
    },
  });
}
