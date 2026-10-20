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
    // Forms people actually write (found in the 29.9 and 15.10 campaign replies).
    'הסרה', 'להסרה', 'הסרה בבקשה', 'ביטול', 'בטל', 'מחק אותי', 'תמחקו אותי', 'לא מעוניינים', 'unsub',
    // Ambiguous verbs as the whole request, or next to the list's name.
    'אני מבקש הסרה', 'אני רוצה הסרה בבקשה', 'בטל אותי', 'ביטול מהרשימה', 'remove', 'remove me please',
    'תמחקו אותי מרשימת התפוצה', 'ביטול הדיוור', 'I want to remove me',
    // Glued prefixes.
    'ותסירו אותי', 'שתסירו אותי בבקשה',
  ])('treats "%s" as a removal request', (text) => {
    expect(detectOptOut(text)).toBe(true);
  });

  it.each([
    'בטל את הפגישה', 'ביטול הפגישה מחר בבקשה', 'מחק את ההודעה הקודמת', 'ביטול עסקה', 'יש דמי ביטול?',
    'remove the parking from the offer', 'Please remove the parking spot', 'הסרה של משכנתא',
    'מה העלות של הסרה של שעבוד', 'תמחקו את המספר הישן', 'ביטול הזמנה לוובינר', 'אפשר לבטל את הפגישה?',
  ])('leaves a short message that merely uses a cancel/delete verb to the conversation: "%s"', (text) => {
    expect(detectOptOut(text)).toBe(false);
  });

  it.each([
    'תסירו אותי בבקשה מרשימת התפוצה שלכם, תודה רבה ולהתראות',
    'היי, אני מבקש להסיר אותי מרשימת הדיוור, אני לא בארץ יותר ואין לי עניין בנדל"ן בישראל',
    'Please unsubscribe me from this list, I did not sign up for these emails and do not want them',
    'אשמח שתורידו אותי מהרשימה כי זה לא רלוונטי בשבילי כרגע, תודה על ההבנה',
  ])('recognises a long removal request that names the list: "%s"', (text) => {
    expect(detectOptOut(text)).toBe(true);
  });

  it.each([
    '', null, undefined,
    'הסרטון שהעליתם מעולה, תודה',
    'אני לא מעוניין בדירה בחיפה אלא בתל אביב, יש לכם משהו שם בתקציב של שני מיליון?',
    'מתי הוובינר הבא?',
    'stop by the office tomorrow at 10, I want to hear about the program and the financing options',
    // Long, mentions a keyword, but is about the deal — not the list.
    'אני רוצה לבטל את הפגישה של מחר ולקבוע למועד אחר בשבוע הבא אם אפשר, תודה',
    'Can you remove the parking spot from the offer and send me the updated price for the apartment?',
  ])('leaves "%s" to the conversation', (text) => {
    expect(detectOptOut(text as string | null | undefined)).toBe(false);
  });

  it('honours a configured keyword list', () => {
    expect(detectOptOut('בלי דיוור', ['בלי דיוור'])).toBe(true);
    expect(detectOptOut('הסר', ['בלי דיוור'])).toBe(false);
  });
});

describe('detectResubscribe', () => {
  it('recognises the comeback command only when it is the whole message', () => {
    expect(detectResubscribe('חזור')).toBe(true);
    expect(detectResubscribe('START')).toBe(true);
    expect(detectResubscribe('"חזור"')).toBe(true);
    expect(detectResubscribe('מה חדש?')).toBe(false);
    // "start" and "חזור" inside a sentence are conversation, not consent.
    expect(detectResubscribe('start by sending me the brochure')).toBe(false);
    expect(detectResubscribe('חזור אליי מחר בבוקר')).toBe(false);
    expect(detectResubscribe('תרשמו אותי שוב')).toBe(false);
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

  it('adds configured keywords to the defaults instead of replacing them', () => {
    // The list migration 128 seeded (and nobody edits) must not freeze detection.
    const cfg = resolveMessaging({ optOutKeywords: ['הסר', 'בלי דיוור'], resubscribeKeywords: ['חזור'] });
    expect(cfg.optOutKeywords).toContain('בלי דיוור');
    expect(cfg.optOutKeywords).toContain('להסרה');
    expect(cfg.optOutKeywords.filter((k) => k === 'הסר')).toHaveLength(1);
    expect(cfg.resubscribeKeywords).toContain('start');
    expect(detectOptOut('בלי דיוור', cfg.optOutKeywords)).toBe(true);
  });
});
