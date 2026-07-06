import { describe, expect, it } from 'vitest';
import {
  CONCIERGE_FALLBACK_TEXTS,
  decideConciergeAction,
  detectExpertRequest,
  renderConciergeText,
} from './member-concierge';

const NOW = new Date('2026-07-06T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

const base = {
  text: 'יש לי שאלה על הקורס',
  prevInboundAt: null as string | null,
  lastGreetedAt: null as string | null,
  lastRepromptedAt: null as string | null,
  episodeGapHours: 6,
  now: NOW,
};

describe('detectExpertRequest', () => {
  it('fires on the magic word and on explicit human requests', () => {
    expect(detectExpertRequest('מומחה')).toBe(true);
    expect(detectExpertRequest('אפשר מומחה בבקשה?')).toBe(true);
    expect(detectExpertRequest('אני רוצה לדבר עם נציג')).toBe(true);
    expect(detectExpertRequest('תנו לי בן אדם אמיתי')).toBe(true);
    expect(detectExpertRequest('צריך שירות לקוחות')).toBe(true);
  });

  it('does not fire on ordinary content questions', () => {
    expect(detectExpertRequest('מה ההבדל בין משכנתא קבועה למשתנה?')).toBe(false);
    expect(detectExpertRequest('איפה השיעור על מיסוי?')).toBe(false);
    expect(detectExpertRequest('')).toBe(false);
    expect(detectExpertRequest(null)).toBe(false);
    // 'נציג' inside a longer word must not fire.
    expect(detectExpertRequest('הנציגות של הבניין')).toBe(false);
  });
});

describe('decideConciergeAction — episodes', () => {
  it('greets on the first-ever message', () => {
    expect(decideConciergeAction(base)).toBe('greet');
  });

  it('expert wins over everything', () => {
    expect(decideConciergeAction({ ...base, text: 'מומחה' })).toBe('expert');
    expect(
      decideConciergeAction({
        ...base,
        text: 'מומחה',
        prevInboundAt: hoursAgo(0.1),
        lastGreetedAt: hoursAgo(0.2),
        lastRepromptedAt: hoursAgo(0.1),
      }),
    ).toBe('expert');
  });

  it('reprompts once within an episode, then goes silent', () => {
    // 2nd message, 10 minutes after the first; greeted at first message.
    const second = { ...base, prevInboundAt: hoursAgo(0.17), lastGreetedAt: hoursAgo(0.17) };
    expect(decideConciergeAction(second)).toBe('reprompt');
    // 3rd message after the reprompt → silent.
    const third = {
      ...second,
      prevInboundAt: hoursAgo(0.08),
      lastRepromptedAt: hoursAgo(0.08),
    };
    expect(decideConciergeAction(third)).toBe('silent');
  });

  it('a gap longer than episode_gap_hours starts a fresh episode → greet again', () => {
    expect(
      decideConciergeAction({
        ...base,
        prevInboundAt: hoursAgo(7),
        lastGreetedAt: hoursAgo(7),
        lastRepromptedAt: hoursAgo(6.5),
      }),
    ).toBe('greet');
  });

  it('exactly at the gap boundary is still the same episode', () => {
    expect(
      decideConciergeAction({
        ...base,
        prevInboundAt: hoursAgo(6),
        lastGreetedAt: hoursAgo(6),
      }),
    ).toBe('reprompt');
  });

  it('greets when member was marked mid-conversation (no greet stamp yet)', () => {
    expect(decideConciergeAction({ ...base, prevInboundAt: hoursAgo(0.5) })).toBe('greet');
  });
});

describe('renderConciergeText', () => {
  it('fills name and John phone', () => {
    const out = renderConciergeText(CONCIERGE_FALLBACK_TEXTS.member_welcome_v1, {
      firstName: 'דנה',
      johnPhone: '055-3083507',
    });
    expect(out).toContain('היי דנה');
    expect(out).toContain('055-3083507');
    expect(out).not.toContain('{{');
  });

  it('falls back to a neutral greeting without a name', () => {
    const out = renderConciergeText(CONCIERGE_FALLBACK_TEXTS.member_welcome_v1, {
      firstName: null,
      johnPhone: '055-3083507',
    });
    expect(out).toContain('חבר/ת התוכנית');
  });
});
