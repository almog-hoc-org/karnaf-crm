import { describe, expect, it } from 'vitest';
import { extractReplyText } from './email-reply';
import { detectOptOut } from './opt-out';

const CAMPAIGN = [
  'שלום דנה,',
  'השנה החדשה היא הזדמנות טובה לעצור ולבדוק: איך מקבלים החלטת נדל״ן חכמה יותר? בתוכנית הדרך לדירה',
  'אנחנו מלווים רוכשים צעד אחר צעד, מהבדיקה הראשונה ועד החתימה.',
  'להסרה מרשימת התפוצה לחצו כאן או השיבו למייל זה עם המילה "הסר".',
].join('\n');

const gmailHe = (reply: string) =>
  `${reply}\n\nבתאריך יום ג׳, 29 בספט׳ 2026 ב-18:01 מאת קרנף נדל"ן <info@karnafnadlan.com>:\n\n${CAMPAIGN.split('\n').map((l) => `> ${l}`).join('\n')}`;
const gmailEn = (reply: string) =>
  `${reply}\n\nOn Tue, 29 Sep 2026 at 18:01, קרנף נדל"ן <info@karnafnadlan.com> wrote:\n> ${CAMPAIGN}`;
const outlook = (reply: string) =>
  `${reply}\r\n\r\n________________________________\r\nFrom: קרנף נדל"ן <info@karnafnadlan.com>\r\nSent: Tuesday, September 29, 2026 6:01 PM\r\n\r\n${CAMPAIGN}`;
const iphone = (reply: string) =>
  `${reply}\n\nנשלח מה-iPhone שלי\n\n> ${CAMPAIGN}`;

describe('extractReplyText', () => {
  it.each([
    ['Gmail Hebrew', gmailHe('הסר')],
    ['Gmail English client', gmailEn('תסירו אותי בבקשה')],
    ['Outlook', outlook('לא מעוניין, תודה')],
    ['iPhone', iphone('הסר אותי')],
  ])('cuts the quoted campaign (%s) so the removal request is detected', (_name, body) => {
    const reply = extractReplyText(body);
    expect(reply.length).toBeLessThan(40);
    expect(detectOptOut(reply)).toBe(true);
    // Without the cut the whole body is far too long to count as a command.
    expect(detectOptOut(body)).toBe(false);
  });

  it('keeps a real question as a question', () => {
    const reply = extractReplyText(gmailHe('כמה עולה הקורס? ואפשר לפרוס לתשלומים?'));
    expect(reply).toBe('כמה עולה הקורס? ואפשר לפרוס לתשלומים?');
    expect(detectOptOut(reply)).toBe(false);
  });

  it('drops a signature', () => {
    expect(extractReplyText('הסר\n-- \nיוסי כהן\n050-0000000')).toBe('הסר');
  });

  it('handles empty input', () => {
    expect(extractReplyText('')).toBe('');
    expect(extractReplyText(null)).toBe('');
  });
});
