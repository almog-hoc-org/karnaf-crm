import { describe, expect, it } from 'vitest';
import { canContactLead, isSnoozed, type ContactGuardLead } from './contact-guard';

const HOUR = 3600_000;
const NOW = new Date('2026-08-16T12:00:00.000Z');

function lead(over: Partial<ContactGuardLead> = {}): ContactGuardLead {
  return { phone: '0501234567', email: 'a@b.co', ig_user_id: 'ig-1', consent_email: true, ...over };
}

describe('canContactLead', () => {
  it('allows a plain proactive WhatsApp send', () => {
    expect(canContactLead(lead(), { channel: 'whatsapp', kind: 'proactive', now: NOW })).toEqual({ ok: true });
  });

  it.each([
    ['do_not_contact', { do_not_contact: true }],
    ['removed_by_request', { removed_by_request: true }],
  ] as const)('blocks %s on every kind and channel', (reason, patch) => {
    for (const kind of ['proactive', 'reply'] as const) {
      expect(canContactLead(lead(patch), { channel: 'whatsapp', kind, now: NOW })).toEqual({ ok: false, reason });
    }
  });

  it('blocks a snoozed lead proactively but still allows a reply', () => {
    const snoozed = lead({ snoozed_until: new Date(NOW.getTime() + 48 * HOUR).toISOString() });
    expect(canContactLead(snoozed, { channel: 'whatsapp', kind: 'proactive', now: NOW }))
      .toEqual({ ok: false, reason: 'snoozed' });
    // Answering a customer who wrote to us is not proactive contact.
    expect(canContactLead(snoozed, { channel: 'whatsapp', kind: 'reply', now: NOW })).toEqual({ ok: true });
  });

  it('treats an expired snooze as no snooze', () => {
    const expired = lead({ snoozed_until: new Date(NOW.getTime() - HOUR).toISOString() });
    expect(canContactLead(expired, { channel: 'whatsapp', kind: 'proactive', now: NOW })).toEqual({ ok: true });
  });

  it('blocks no_proactive_contact proactively but allows a reply', () => {
    const noProactive = lead({ no_proactive_contact: true });
    expect(canContactLead(noProactive, { channel: 'whatsapp', kind: 'proactive', now: NOW }))
      .toEqual({ ok: false, reason: 'no_proactive_contact' });
    expect(canContactLead(noProactive, { channel: 'whatsapp', kind: 'reply', now: NOW })).toEqual({ ok: true });
  });

  it('requires the identity the channel actually needs', () => {
    expect(canContactLead(lead({ phone: null }), { channel: 'whatsapp', kind: 'proactive', now: NOW }))
      .toEqual({ ok: false, reason: 'no_phone' });
    expect(canContactLead(lead({ phone: '   ' }), { channel: 'whatsapp', kind: 'proactive', now: NOW }))
      .toEqual({ ok: false, reason: 'no_phone' });
    expect(canContactLead(lead({ ig_user_id: null }), { channel: 'instagram', kind: 'proactive', now: NOW }))
      .toEqual({ ok: false, reason: 'no_identity' });
    expect(canContactLead(lead({ email: null }), { channel: 'email', kind: 'proactive', now: NOW }))
      .toEqual({ ok: false, reason: 'no_email' });
    // A missing phone does not block an email send.
    expect(canContactLead(lead({ phone: null }), { channel: 'email', kind: 'proactive', now: NOW }))
      .toEqual({ ok: true });
  });

  it('enforces email consent unless explicitly waived', () => {
    const noConsent = lead({ consent_email: false });
    expect(canContactLead(noConsent, { channel: 'email', kind: 'proactive', now: NOW }))
      .toEqual({ ok: false, reason: 'no_consent' });
    expect(canContactLead(noConsent, { channel: 'email', kind: 'proactive', requireEmailConsent: false, now: NOW }))
      .toEqual({ ok: true });
    // Unknown consent is not consent.
    expect(canContactLead(lead({ consent_email: null }), { channel: 'email', kind: 'proactive', now: NOW }))
      .toEqual({ ok: false, reason: 'no_consent' });
  });

  it('reports hard suppression before anything else', () => {
    const worst = lead({ do_not_contact: true, snoozed_until: new Date(NOW.getTime() + HOUR).toISOString(), phone: null });
    expect(canContactLead(worst, { channel: 'whatsapp', kind: 'proactive', now: NOW }))
      .toEqual({ ok: false, reason: 'do_not_contact' });
  });

  it('does not block closed leads — a won lead still gets student check-ins', () => {
    // lead_status is intentionally absent from the guard's inputs.
    expect(canContactLead(lead(), { channel: 'whatsapp', kind: 'proactive', now: NOW })).toEqual({ ok: true });
  });
});

describe('isSnoozed', () => {
  it('handles null, garbage and both sides of now', () => {
    expect(isSnoozed(null, NOW)).toBe(false);
    expect(isSnoozed(undefined, NOW)).toBe(false);
    expect(isSnoozed('not-a-date', NOW)).toBe(false);
    expect(isSnoozed(new Date(NOW.getTime() + 1000).toISOString(), NOW)).toBe(true);
    expect(isSnoozed(new Date(NOW.getTime() - 1000).toISOString(), NOW)).toBe(false);
  });
});
