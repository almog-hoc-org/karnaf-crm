// The single answer to "may we message this lead right now?". This file IS
// the tested mirror of _shared/contact-guard.ts; keep in sync.
//
// Before this existed, snoozed_until and no_proactive_contact were honoured
// in exactly one place — the attention-inbox RPC, which only decides what
// the OPERATOR sees. Every outbound path (broadcasts, journeys, the
// automation engine, re-engagement) sent anyway, so "snooze this lead for
// two weeks" quietly meant "hide it from my list while we keep messaging
// them". The promise the operator makes has to bind the machine too.
//
// The kind distinction is the whole design:
//   proactive — we initiate (broadcast, journey step, nurture nudge).
//               Snooze and no-proactive-contact block it.
//   reply     — the customer wrote and we answer. Only hard suppressions
//               (DNC / removal) apply; answering someone who just messaged
//               us is never "proactive contact", and the inbox already
//               treats an inbound as cancelling a snooze.
//
// Deliberately NOT checked here: lead_status. A won lead still gets the
// biweekly student check-in (student-lifecycle.ts) — closing a sale is not
// consent withdrawal. Broadcast segmentation excludes closed statuses on
// its own, where that exclusion actually belongs.

export type ContactChannel = 'whatsapp' | 'instagram' | 'email';

export interface ContactGuardLead {
  phone?: string | null;
  email?: string | null;
  ig_user_id?: string | null;
  do_not_contact?: boolean | null;
  removed_by_request?: boolean | null;
  snoozed_until?: string | null;
  no_proactive_contact?: boolean | null;
  consent_email?: boolean | null;
}

export type ContactBlockReason =
  | 'do_not_contact'
  | 'removed_by_request'
  | 'snoozed'
  | 'no_proactive_contact'
  | 'no_phone'
  | 'no_email'
  | 'no_identity'
  | 'no_consent';

export type ContactDecision = { ok: true } | { ok: false; reason: ContactBlockReason };

export interface ContactGuardOptions {
  channel: ContactChannel;
  kind: 'proactive' | 'reply';
  // Israeli spam law: marketing email needs prior opt-in. Only consulted
  // for the email channel.
  requireEmailConsent?: boolean;
  now?: Date;
}

export function canContactLead(lead: ContactGuardLead, opts: ContactGuardOptions): ContactDecision {
  if (lead.do_not_contact) return { ok: false, reason: 'do_not_contact' };
  if (lead.removed_by_request) return { ok: false, reason: 'removed_by_request' };

  if (opts.kind === 'proactive') {
    if (lead.no_proactive_contact) return { ok: false, reason: 'no_proactive_contact' };
    // A snooze that has already expired is not a block — the inbox brings
    // such a lead back on its own (snoozed_until <= now in the RPC).
    if (isSnoozed(lead.snoozed_until, opts.now)) return { ok: false, reason: 'snoozed' };
  }

  switch (opts.channel) {
    case 'whatsapp':
      if (!nonEmpty(lead.phone)) return { ok: false, reason: 'no_phone' };
      break;
    case 'instagram':
      if (!nonEmpty(lead.ig_user_id)) return { ok: false, reason: 'no_identity' };
      break;
    case 'email':
      if (!nonEmpty(lead.email)) return { ok: false, reason: 'no_email' };
      if (opts.requireEmailConsent !== false && lead.consent_email !== true) {
        return { ok: false, reason: 'no_consent' };
      }
      break;
  }

  return { ok: true };
}

export function isSnoozed(snoozedUntil: string | null | undefined, now = new Date()): boolean {
  if (!snoozedUntil) return false;
  const until = Date.parse(snoozedUntil);
  return Number.isFinite(until) && until > now.getTime();
}

// Hebrew labels for the skip reasons an operator actually sees (broadcast
// recipient rows, journey step results).
export const CONTACT_BLOCK_LABELS: Record<ContactBlockReason, string> = {
  do_not_contact: 'מסומן כלא ליצור קשר',
  removed_by_request: 'ביקש הסרה',
  snoozed: 'בהשהיה',
  no_proactive_contact: 'ללא פנייה יזומה',
  no_phone: 'אין מספר טלפון',
  no_email: 'אין כתובת מייל',
  no_identity: 'אין מזהה ערוץ',
  no_consent: 'אין הסכמה לדיוור',
};

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
