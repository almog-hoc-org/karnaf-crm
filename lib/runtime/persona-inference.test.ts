import { describe, expect, it } from 'vitest';
import { inferPersona, guidanceFor } from './persona-inference';

describe('inferPersona', () => {
  it('returns unknown for empty input with no source hint', () => {
    const r = inferPersona({ leadMessages: [], source: null });
    expect(r.persona).toBe('unknown');
    expect(r.guidance.length).toBeGreaterThan(0);
  });

  it('uses webinar source as analyst pre-persona when no messages yet', () => {
    const r = inferPersona({ leadMessages: [], source: 'webinar' });
    expect(r.persona).toBe('analyst');
  });

  it('uses instagram_dm source as impulsive pre-persona', () => {
    const r = inferPersona({ leadMessages: [], source: 'instagram_dm' });
    expect(r.persona).toBe('impulsive');
  });

  it('detects skeptical persona from question + objection language', () => {
    const r = inferPersona({
      leadMessages: ['אבל איך אני יודע שזה באמת עובד?', 'בעבר ניסיתי משהו דומה ונכשלתי'],
      source: 'youtube_short',
    });
    expect(r.persona).toBe('skeptical');
  });

  it('detects delegator persona from partner reference', () => {
    const r = inferPersona({
      leadMessages: ['אני צריך לבדוק עם בן הזוג שלי קודם'],
      source: null,
    });
    expect(r.persona).toBe('delegator');
  });

  it('detects analyst when messages are verbose + questioning', () => {
    const r = inferPersona({
      leadMessages: [
        'שלום, אני מתעניין בתוכנית ורוצה להבין מה ההפרשים הצפויים לטווח של 3 שנים, מה התוכן בכל שלב, וכמה זמן השקעה נדרשת בשבוע. תוכל לשתף לוח זמנים ברור?',
        'מה אחוז הסיום הממוצע של בוגרים והאם יש סטטיסטיקה על תוצאות בשנה הראשונה?',
      ],
      source: 'newsletter',
    });
    expect(r.persona).toBe('analyst');
  });

  it('detects impulsive when most messages are short', () => {
    const r = inferPersona({
      leadMessages: ['כן!', 'מעניין', 'איך מתחילים', 'מתי?'],
      source: 'tiktok',
    });
    expect(r.persona).toBe('impulsive');
  });

  it('skeptical signal beats source-based analyst guess', () => {
    const r = inferPersona({
      leadMessages: ['באמת? לא בטוח שזה מתאים לי, אבל אני שואל'],
      source: 'webinar',
    });
    expect(r.persona).toBe('skeptical');
  });
});

describe('guidanceFor', () => {
  it('returns at least one line per known persona', () => {
    for (const p of ['analyst', 'impulsive', 'skeptical', 'delegator', 'unknown'] as const) {
      expect(guidanceFor(p).length).toBeGreaterThan(0);
    }
  });

  it('analyst guidance mentions structure or numbers', () => {
    const g = guidanceFor('analyst').join(' ');
    expect(g).toMatch(/ROI|מספרים|מסודר/);
  });

  it('delegator guidance suggests including partner/family', () => {
    const g = guidanceFor('delegator').join(' ');
    expect(g).toMatch(/בן|בת זוג|משפחה/);
  });
});
