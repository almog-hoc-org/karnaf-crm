import { describe, expect, it } from 'vitest';
import {
  appendOptOutFooter,
  DEFAULT_OPT_OUT_FOOTER,
  detectOptOut,
  detectResubscribe,
  resolveMessaging,
} from './opt-out';

describe('detectOptOut', () => {
  it.each([
    'הסר', 'הסירו אותי', 'הסר!', '"הסר"', 'תסירו אותי מהרשימה', 'להסיר אותי בבקשה',
    'STOP', 'stop', 'Unsubscribe', 'remove me please', 'לא מעוניין', 'אל תשלחו לי יותר',
    '🛑 הסר', 'תפסיקו לשלוח',
  ])('treats "%s" as a removal request', (text) => {
    expect(detectOptOut(text)).toBe(true);
  });

  it.each([
    '', null, undefined,
    'הסרטון שהעליתם מעולה, תודה',
    'אני לא מעוניין בדירה בחיפה אלא בתל אביב, יש לכם משהו שם בתקציב של שני מיליון?',
    'מתי הוובינר הבא?',
    'stop by the office tomorrow at 10, I want to hear about the program and the financing options',
  ])('leaves "%s" to the conversation', (text) => {
    expect(detectOptOut(text as string | null | undefined)).toBe(false);
  });

  it('honours a configured keyword list', () => {
    expect(detectOptOut('בלי דיוור', ['בלי דיוור'])).toBe(true);
    expect(detectOptOut('הסר', ['בלי דיוור'])).toBe(false);
  });
});

describe('detectResubscribe', () => {
  it('recognises the comeback keywords and nothing else', () => {
    expect(detectResubscribe('חזור')).toBe(true);
    expect(detectResubscribe('תרשמו אותי שוב')).toBe(true);
    expect(detectResubscribe('מה חדש?')).toBe(false);
  });
});

describe('appendOptOutFooter', () => {
  it('adds the footer on its own paragraph', () => {
    expect(appendOptOutFooter('היי דנה, יש לנו עדכון.')).toBe(`היי דנה, יש לנו עדכון.\n\n${DEFAULT_OPT_OUT_FOOTER}`);
  });

  it('adds it inline for single-line template params', () => {
    expect(appendOptOutFooter('היי דנה, יש לנו עדכון.', DEFAULT_OPT_OUT_FOOTER, { oneLine: true }))
      .toBe(`היי דנה, יש לנו עדכון. · ${DEFAULT_OPT_OUT_FOOTER}`);
  });

  it('never doubles the footer', () => {
    const once = appendOptOutFooter('שלום');
    expect(appendOptOutFooter(once)).toBe(once);
  });

  it('returns the body unchanged when the footer is blank', () => {
    expect(appendOptOutFooter('שלום', '   ')).toBe('שלום');
  });
});

describe('resolveMessaging', () => {
  it('falls back per field and ignores malformed values', () => {
    const cfg = resolveMessaging({ optOutFooter: 'להסרה: הסר', optOutKeywords: 'not-a-list', optOutConfirmation: '' });
    expect(cfg.optOutFooter).toBe('להסרה: הסר');
    expect(cfg.optOutKeywords).toContain('הסר');
    expect(cfg.optOutConfirmation.length).toBeGreaterThan(0);
  });
});
