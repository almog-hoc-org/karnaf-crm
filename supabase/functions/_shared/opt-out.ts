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

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.117.2';
import { log } from './logger.ts';

export const DEFAULT_OPT_OUT_KEYWORDS = [
  'הסר', 'הסרה', 'להסרה', 'הסירו', 'הסירו אותי', 'הסירוני', 'תסיר', 'תסירו', 'תסירו אותי', 'להסיר',
  'תוריד', 'תורידו', 'להוריד אותי', 'תפסיק', 'תפסיקו',
  'בטל', 'ביטול', 'מחק', 'מחקו', 'תמחקו', 'מחקו אותי',
  'לא מעוניין', 'לא מעוניינת', 'לא מעוניינים', 'אל תפנו', 'אל תשלחו',
  'stop', 'unsubscribe', 'unsub', 'remove', 'remove me', 'opt out',
];

// Words that also mean something else in a short customer message: "בטל
// את הפגישה", "מחק את ההודעה הקודמת", "ביטול עסקה", "remove the parking
// from the offer", "הסרה של שעבוד". They count only when they ARE the
// message — allowing "אותי"/"me" and request/courtesy words ("אני מבקש
// הסרה", "הסרה בבקשה") — or when the list is named next to them.
const EXACT_ONLY_KEYWORDS = ['הסרה', 'להסרה', 'בטל', 'ביטול', 'מחק', 'מחקו', 'תמחקו', 'remove'];
const FILLER_WORDS = new Set([
  'אני', 'מבקש', 'מבקשת', 'רוצה', 'בבקשה', 'תודה', 'נא', 'אנא', 'אותי',
  'i', 'me', 'want', 'to', 'would', 'like', 'please', 'pls', 'thanks',
]);

export const DEFAULT_RESUBSCRIBE_KEYWORDS = ['חזור', 'הרשם', 'תרשמו אותי', 'resubscribe', 'start'];

export const DEFAULT_OPT_OUT_FOOTER = 'להסרה מרשימת התפוצה השיבו "הסר"';

export const DEFAULT_OPT_OUT_CONFIRMATION =
  'הוסרת מרשימת התפוצה שלנו ולא נשלח לך עוד הודעות שיווקיות. אם תרצה לחזור, כתוב "חזור".';

export const DEFAULT_RESUBSCRIBE_CONFIRMATION = 'חזרת לרשימת התפוצה שלנו. תודה!';

// Messages longer than this are never treated as a bare command.
const MAX_COMMAND_WORDS = 6;

// Naming the list is what turns a long message into a removal request:
// with one of these present, a removal keyword anywhere in the text is
// enough whatever the length.
const LIST_PHRASES = [
  'רשימת התפוצה', 'מרשימת התפוצה', 'רשימת הדיוור', 'מרשימת הדיוור', 'רשימת תפוצה', 'מהרשימה', 'מהדיוור',
  'דיוור', 'הדיוור', 'התפוצה', 'מהניוזלטר', 'הניוזלטר', 'ניוזלטר', 'mailing list', 'from your list', 'from the list', 'newsletter',
];

// Unambiguous at any length ("unsubscribe", "הסירו אותי") — nobody writes
// these in another sense.
const STRONG_PHRASES = ['unsubscribe', 'הסירו אותי', 'תסירו אותי', 'להסיר אותי', 'הסירוני', 'remove me', 'opt out'];

// Hebrew prefixes glued to the verb: "ותסירו", "שתסירו".
const HEBREW_PREFIXES = ['ו', 'ש'];

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

/**
 * Fill a partial crm_config `messaging` value with defaults; tolerate junk.
 * Keyword lists are ADDED to the defaults, not swapped for them: migration
 * 128 seeded crm_config with the keyword list of its day, nothing in the
 * app edits it, and a list that replaced the defaults silently froze
 * detection at that 19-word version while the code learned new forms.
 */
export function resolveMessaging(raw: unknown): MessagingConfig {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const strList = (v: unknown, fallback: string[]) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length > 0 ? v as string[] : fallback;
  const union = (defaults: string[], extra: string[]) => Array.from(new Set([...defaults, ...extra]));
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v : fallback);
  return {
    optOutKeywords: union(DEFAULT_MESSAGING.optOutKeywords, strList(obj.optOutKeywords, [])),
    resubscribeKeywords: union(DEFAULT_MESSAGING.resubscribeKeywords, strList(obj.resubscribeKeywords, [])),
    optOutFooter: str(obj.optOutFooter, DEFAULT_MESSAGING.optOutFooter),
    optOutConfirmation: str(obj.optOutConfirmation, DEFAULT_MESSAGING.optOutConfirmation),
    resubscribeConfirmation: str(obj.resubscribeConfirmation, DEFAULT_MESSAGING.resubscribeConfirmation),
  };
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    // Quotes, punctuation and emoji around a command ("הסר!", «STOP», 🛑 הסר)
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole-word containment, tolerant of a glued ו/ש prefix on a single-word keyword. */
function containsKeyword(norm: string, kw: string): boolean {
  if (norm === kw) return true;
  const padded = ' ' + norm + ' ';
  if (padded.includes(' ' + kw + ' ')) return true;
  if (!kw.includes(' ') && /^[֐-׿]/.test(kw)) {
    for (const p of HEBREW_PREFIXES) {
      if (padded.includes(' ' + p + kw + ' ')) return true;
    }
  }
  return false;
}

// Our own footer, quoted back at us. A reply carries the campaign underneath
// it, and the campaign ends with "להסרה מרשימת התפוצה לחצו כאן או השיבו
// 'הסר'" — which names the list AND contains the keyword. Lines that look
// like that footer, and quoted lines ("> ..."), are not what the person wrote.
const FOOTER_LINE = /^(?=.*(להסרה|להסיר|unsubscribe|opt[- ]?out))(?=.*(לחצו|השיבו|click|reply|link|קישור)).*$/i;

function stripQuotedAndFooter(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>') && !FOOTER_LINE.test(line.trim()))
    .join('\n');
}

/** The message is the keyword plus nothing but filler ("אני מבקש הסרה", "remove me please"). */
function isBareCommand(norm: string, kw: string): boolean {
  const rest = norm.split(' ').filter((w) => !FILLER_WORDS.has(w)).join(' ');
  return rest === kw || HEBREW_PREFIXES.some((p) => rest === p + kw);
}

function namesTheList(padded: string): boolean {
  return LIST_PHRASES.some((p) => padded.includes(' ' + normalise(p) + ' '));
}

function matchesKeyword(text: string, keywords: string[], opts: { allowLong: boolean }): boolean {
  const norm = normalise(text);
  if (!norm) return false;
  const words = norm.split(' ');
  const kws = keywords.map(normalise).filter(Boolean);
  if (words.length <= MAX_COMMAND_WORDS) {
    const listNamed = namesTheList(' ' + norm + ' ');
    return kws.some((kw) => containsKeyword(norm, kw)
      && (!EXACT_ONLY_KEYWORDS.includes(kw) || listNamed || isBareCommand(norm, kw)));
  }
  if (!opts.allowLong) return false;
  // Long message: only when it is unmistakably about the mailing list, and
  // only on the text the person wrote — not our quoted footer.
  const own = normalise(stripQuotedAndFooter(text));
  if (!own) return false;
  const padded = ' ' + own + ' ';
  if (STRONG_PHRASES.some((p) => padded.includes(' ' + normalise(p) + ' '))) return true;
  return namesTheList(padded) && kws.some((kw) => containsKeyword(own, kw));
}

/** True when the inbound text is a removal request. */
export function detectOptOut(text: string | null | undefined, keywords = DEFAULT_OPT_OUT_KEYWORDS): boolean {
  if (!text) return false;
  return matchesKeyword(text, keywords, { allowLong: true });
}

/**
 * True when the inbound text asks to be put back on the list. Exact match
 * only: "start" or "חזור" inside a sentence ("start by sending me the
 * brochure", "חזור אליי מחר") is conversation, not consent.
 */
export function detectResubscribe(text: string | null | undefined, keywords = DEFAULT_RESUBSCRIBE_KEYWORDS): boolean {
  if (!text) return false;
  const norm = normalise(text);
  if (!norm) return false;
  return keywords.map(normalise).filter(Boolean).some((kw) => norm === kw);
}

/**
 * Append the opt-out line to an outgoing marketing text. Idempotent: a
 * body that already carries the footer (or already tells the reader how
 * to unsubscribe) is returned unchanged. `oneLine` is for template
 * parameters, which Meta rejects when they contain newlines.
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

  // Each cleanup is best-effort and independent: a failure is logged and the
  // next one still runs (dispatch-outbound's contact guard is the backstop).
  // supabase-js reports failures in `error`, it does not throw — checking
  // only for a throw hid that the journey cancel below had never matched a
  // row: journey_runs keys the lead as contact_id (migration 067), not
  // lead_id, so every opt-out left the lead's journeys running.
  {
    const { data: runs, error: runErr } = await supabase
      .from('journey_runs')
      .update({ status: 'cancelled', cancellation_reason: 'opt_out', cancelled_at: nowIso })
      .eq('contact_id', input.leadId)
      .eq('status', 'active')
      .select('id');
    if (runErr) log.warn('opt_out_journey_cancel_failed', { fn: 'opt-out', leadId: input.leadId, err: runErr.message });
    result.cancelledJourneys = runs?.length ?? 0;
  }
  {
    const { data: rows, error: dispatchErr } = await supabase
      .from('outbound_dispatch')
      .update({ status: 'failed', last_error: 'opt_out', failed_at: nowIso })
      .eq('lead_id', input.leadId)
      .in('status', ['pending', 'in_flight'])
      .eq('payload->>kind', 'template')
      .select('id');
    if (dispatchErr) log.warn('opt_out_dispatch_cancel_failed', { fn: 'opt-out', leadId: input.leadId, err: dispatchErr.message });
    result.cancelledDispatches = rows?.length ?? 0;
  }
  {
    const { data: rows, error: recipientErr } = await supabase
      .from('broadcast_recipients')
      .update({ status: 'skipped', error: 'opt_out' })
      .eq('lead_id', input.leadId)
      .in('status', ['pending', 'enqueued'])
      .select('id');
    if (recipientErr) log.warn('opt_out_recipient_skip_failed', { fn: 'opt-out', leadId: input.leadId, err: recipientErr.message });
    result.skippedRecipients = rows?.length ?? 0;
  }

  log.info('opt_out_applied', { fn: 'opt-out', leadId: input.leadId, basis: input.basis, channel: input.channel, ...result });
  return result;
}

/**
 * The lead asked to come back — on the channel they wrote on. "חזור" over
 * WhatsApp restores WhatsApp consent and lifts the proactive-contact block;
 * it is not an opt-in to marketing email (חוק הספאם wants an explicit one
 * for that), so consent_email is left alone unless the request came by email.
 */
export async function applyResubscribe(
  supabase: SupabaseClient,
  input: { leadId: string; channel: OptOutChannel; text?: string | null; correlationId?: string; conversationId?: string | null },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const updates: Record<string, unknown> = { no_proactive_contact: false, consent_updated_at: nowIso };
  const channels: string[] = [];
  if (input.channel === 'email') {
    updates.consent_email = true;
    channels.push('email');
  } else {
    updates.consent_whatsapp = true;
    channels.push('whatsapp');
  }
  const { error } = await supabase.from('leads').update(updates).eq('id', input.leadId);
  if (error) throw error;
  await supabase.from('lead_events').insert({
    lead_id: input.leadId,
    conversation_id: input.conversationId ?? null,
    event_type: 'consent_granted',
    actor_type: 'system',
    event_payload: {
      channels,
      channel: input.channel,
      basis: 'inbound_request',
      text: input.text ? String(input.text).slice(0, 200) : null,
      correlation_id: input.correlationId ?? null,
    },
  });
}
