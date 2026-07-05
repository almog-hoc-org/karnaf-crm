import { describe, expect, it } from 'vitest';
import { PLAYBOOKS, selectPlaybook, type PlaybookSelectionInput } from './playbooks';

const baseInput = (overrides: Partial<PlaybookSelectionInput> = {}): PlaybookSelectionInput => ({
  inboundText: '',
  leadStatus: 'new',
  source: 'whatsapp',
  paymentStatus: null,
  hoursSinceLastInbound: null,
  freeAdviceCount: 0,
  ...overrides,
});

describe('selectPlaybook priority ordering', () => {
  it('opt_out wins over every other signal, including payment_pending and phone request', () => {
    const result = selectPlaybook(
      baseInput({
        inboundText: 'תודה אבל לא מעוניין, גם תתקשר אלי במקום',
        leadStatus: 'payment_pending',
        freeAdviceCount: 99,
      }),
    );
    expect(result.name).toBe('opt_out');
  });

  it('phone_request wins over payment_pending and price keywords', () => {
    const result = selectPlaybook(
      baseInput({
        inboundText: 'אפשר שתתקשר אלי לגבי המחיר?',
        leadStatus: 'payment_pending',
      }),
    );
    expect(result.name).toBe('phone_request');
  });

  it('payment_pending_rescue takes precedence over price keywords when no opt-out / phone signal', () => {
    const result = selectPlaybook(
      baseInput({
        inboundText: 'מה לגבי המחיר?',
        leadStatus: 'payment_pending',
      }),
    );
    expect(result.name).toBe('payment_pending_rescue');
  });

  it('price_objection beats free_advice_boundary even when advice count is high', () => {
    const result = selectPlaybook(
      baseInput({
        inboundText: 'כמה עולה התוכנית?',
        leadStatus: 'responded',
        freeAdviceCount: 5,
      }),
    );
    expect(result.name).toBe('price_objection');
  });

  it('free_advice_boundary triggers at exactly 3 advisory turns', () => {
    expect(selectPlaybook(baseInput({ leadStatus: 'responded', freeAdviceCount: 2 })).name).toBe('qualification');
    expect(selectPlaybook(baseInput({ leadStatus: 'responded', freeAdviceCount: 3 })).name).toBe(
      'free_advice_boundary',
    );
  });
});

describe('selectPlaybook status-driven defaults', () => {
  it('qualified → checkout_push', () => {
    expect(selectPlaybook(baseInput({ leadStatus: 'qualified' })).name).toBe('checkout_push');
  });

  it.each(['first_contact_sent', 'responded', 'nurture'])(
    '%s → qualification',
    (leadStatus) => {
      expect(selectPlaybook(baseInput({ leadStatus })).name).toBe('qualification');
    },
  );

  it('new + whatsapp → first_contact_whatsapp_inbound', () => {
    expect(selectPlaybook(baseInput({ leadStatus: 'new', source: 'whatsapp' })).name).toBe(
      'first_contact_whatsapp_inbound',
    );
  });

  it('new + instagram_dm → first_contact_whatsapp_inbound (DM treated like WhatsApp)', () => {
    expect(selectPlaybook(baseInput({ leadStatus: 'new', source: 'instagram_dm' })).name).toBe(
      'first_contact_whatsapp_inbound',
    );
  });

  it('new + landing_page → first_contact_form_lead', () => {
    expect(selectPlaybook(baseInput({ leadStatus: 'new', source: 'landing_page' })).name).toBe(
      'first_contact_form_lead',
    );
  });

  it('new + already greeted → qualification (regression: no re-greeting loop)', () => {
    expect(
      selectPlaybook(baseInput({ leadStatus: 'new', source: 'landing_page', hasPriorBotMessage: true })).name,
    ).toBe('qualification');
  });

  it('unknown lead_status falls back to qualification', () => {
    expect(selectPlaybook(baseInput({ leadStatus: 'something_unrecognized' })).name).toBe('qualification');
  });
});

describe('selectPlaybook keyword detection', () => {
  it('matches Hebrew opt-out variants', () => {
    for (const phrase of ['לא מעוניין', 'תסיר אותי בבקשה', 'להסיר מהרשימה', 'תפסיק לשלוח']) {
      expect(selectPlaybook(baseInput({ inboundText: phrase })).name).toBe('opt_out');
    }
  });

  it('matches English opt-out keywords case-insensitively', () => {
    expect(selectPlaybook(baseInput({ inboundText: 'STOP messaging me' })).name).toBe('opt_out');
    expect(selectPlaybook(baseInput({ inboundText: 'please Unsubscribe' })).name).toBe('opt_out');
  });

  it('matches Hebrew phone-request variants', () => {
    for (const phrase of [
      'אפשר שתתקשר אליי',
      'אני רוצה שיחה טלפונית',
      'תעביר אותי לנציג',
      'אפשר לדבר איתי?',
      'תן לי בן אדם בבקשה',
    ]) {
      expect(selectPlaybook(baseInput({ inboundText: phrase })).name).toBe('phone_request');
    }
  });

  it('matches price keywords beyond just "מחיר"', () => {
    for (const phrase of ['מה העלות?', 'כמה עולה', 'מה התקציב הנדרש', 'איך עובד התשלום']) {
      expect(
        selectPlaybook(baseInput({ inboundText: phrase, leadStatus: 'responded' })).name,
      ).toBe('price_objection');
    }
  });

  it('does not trigger price_objection when none of the price keywords appear', () => {
    expect(
      selectPlaybook(baseInput({ inboundText: 'אני מתלבט אם זה מתאים לי', leadStatus: 'responded' })).name,
    ).toBe('qualification');
  });
});

describe('PLAYBOOKS catalog integrity', () => {
  it('every playbook returned by selectPlaybook is present in PLAYBOOKS', () => {
    const reachable = new Set([
      selectPlaybook(baseInput({ inboundText: 'stop' })).name,
      selectPlaybook(baseInput({ inboundText: 'תתקשר' })).name,
      selectPlaybook(baseInput({ leadStatus: 'payment_pending' })).name,
      selectPlaybook(baseInput({ inboundText: 'מחיר', leadStatus: 'responded' })).name,
      selectPlaybook(baseInput({ leadStatus: 'responded', freeAdviceCount: 3 })).name,
      selectPlaybook(baseInput({ leadStatus: 'qualified' })).name,
      selectPlaybook(baseInput({ leadStatus: 'first_contact_sent' })).name,
      selectPlaybook(baseInput({ leadStatus: 'new', source: 'whatsapp' })).name,
      selectPlaybook(baseInput({ leadStatus: 'new', source: 'landing_page' })).name,
    ]);
    const known = new Set(PLAYBOOKS.map((p) => p.name));
    for (const n of reachable) expect(known.has(n)).toBe(true);
  });

  it('playbook names are unique', () => {
    const names = PLAYBOOKS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every playbook has a non-empty objective and at least one allowed next status', () => {
    for (const p of PLAYBOOKS) {
      expect(p.objective.length).toBeGreaterThan(0);
      expect(p.allowedNextStatuses.length).toBeGreaterThan(0);
    }
  });

  it('opt_out only allows terminal closure transitions', () => {
    const optOut = PLAYBOOKS.find((p) => p.name === 'opt_out')!;
    expect(optOut.allowedNextStatuses.sort()).toEqual(['do_not_contact', 'removed_by_request']);
  });

  it('phone_request only routes to human_handoff', () => {
    const phone = PLAYBOOKS.find((p) => p.name === 'phone_request')!;
    expect(phone.allowedNextStatuses).toEqual(['human_handoff']);
  });
});

describe('selectPlaybook intent routing', () => {
  it('high-confidence dnc_request intent routes to opt_out even without stopWords', () => {
    const r = selectPlaybook(
      baseInput({
        inboundText: 'אל תשלחו לי יותר הודעות',
        inferredIntent: 'dnc_request',
        intentConfidence: 'high',
      }),
    );
    expect(r.name).toBe('opt_out');
  });

  it('high-confidence escalation_request intent routes to phone_request', () => {
    const r = selectPlaybook(
      baseInput({
        inboundText: 'אני רוצה לדבר עם אדם אמיתי',
        inferredIntent: 'escalation_request',
        intentConfidence: 'high',
      }),
    );
    expect(r.name).toBe('phone_request');
  });

  it('high-confidence buy_signal on qualified lead routes to checkout_push', () => {
    const r = selectPlaybook(
      baseInput({
        inboundText: 'מוכן להירשם, איך משלמים?',
        leadStatus: 'qualified',
        inferredIntent: 'buy_signal',
        intentConfidence: 'high',
      }),
    );
    expect(r.name).toBe('checkout_push');
  });

  it('objection intent routes to price_objection even without price keyword', () => {
    const r = selectPlaybook(
      baseInput({
        inboundText: 'לא בטוח שזה מתאים לי כרגע',
        leadStatus: 'responded',
        inferredIntent: 'objection',
        intentConfidence: 'medium',
      }),
    );
    expect(r.name).toBe('price_objection');
  });

  it('low-confidence intent does NOT override keyword logic', () => {
    const r = selectPlaybook(
      baseInput({
        inboundText: 'תודה',
        leadStatus: 'new',
        inferredIntent: 'dnc_request',
        intentConfidence: 'low',
      }),
    );
    expect(r.name).not.toBe('opt_out');
  });
});
