import { describe, expect, it } from 'vitest';
import { extractTopicsFromText, mergeTopics, summariseTopicsForPrompt } from './topics';

describe('extractTopicsFromText', () => {
  it('returns empty for empty input', () => {
    expect(extractTopicsFromText('')).toEqual([]);
    expect(extractTopicsFromText(null)).toEqual([]);
  });

  it('detects price topic from Hebrew keyword', () => {
    expect(extractTopicsFromText('המחיר הוא 4500 שקל')).toContain('price');
  });

  it('detects timeline + format together', () => {
    const r = extractTopicsFromText('מתי המפגש הבא ואיך הוא מתקיים אונליין?');
    expect(r).toContain('timeline');
    expect(r).toContain('format');
  });

  it('detects partner topic', () => {
    expect(extractTopicsFromText('אדבר עם בן הזוג שלי קודם')).toContain('partner');
  });

  it('detects next_steps for registration language', () => {
    expect(extractTopicsFromText('אשלח לך קישור להרשמה')).toContain('next_steps');
  });
});

describe('mergeTopics', () => {
  it('initialises with new hits', () => {
    const result = mergeTopics(null, ['price', 'timeline']);
    expect(result.length).toBe(2);
    expect(result.every((t) => t.count === 1)).toBe(true);
  });

  it('increments existing topic counts', () => {
    const initial = mergeTopics(null, ['price']);
    const after = mergeTopics(initial, ['price']);
    expect(after.find((t) => t.topic === 'price')?.count).toBe(2);
  });

  it('preserves untouched topics', () => {
    const t1 = mergeTopics(null, ['timeline'], new Date('2026-05-13T08:00:00Z'));
    const t2 = mergeTopics(t1, ['price'], new Date('2026-05-13T09:00:00Z'));
    const timeline = t2.find((t) => t.topic === 'timeline');
    expect(timeline?.count).toBe(1);
    expect(timeline?.last_at).toBe('2026-05-13T08:00:00.000Z');
  });

  it('drops invalid entries', () => {
    const result = mergeTopics(
      [
        { topic: 'price', count: 3, last_at: '2026-05-13T10:00:00Z' },
        // @ts-expect-error - intentionally invalid
        { topic: '', count: 5, last_at: 'x' },
      ],
      ['price'],
    );
    expect(result.length).toBe(1);
    expect(result[0]?.count).toBe(4);
  });
});

describe('summariseTopicsForPrompt', () => {
  it('returns empty string for empty input', () => {
    expect(summariseTopicsForPrompt(null)).toBe('');
    expect(summariseTopicsForPrompt([])).toBe('');
  });

  it('formats counts with age bucket', () => {
    const now = '2026-05-13T12:00:00Z';
    const out = summariseTopicsForPrompt(
      [
        { topic: 'price', count: 3, last_at: '2026-05-13T11:30:00Z' },
        { topic: 'timeline', count: 1, last_at: '2026-05-12T10:00:00Z' },
      ],
      now,
    );
    expect(out).toContain('price=3x');
    expect(out).toContain('timeline=1x');
    expect(out).toMatch(/30m|29m/);
    expect(out).toMatch(/1d/);
  });
});
