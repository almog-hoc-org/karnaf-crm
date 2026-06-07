import { describe, expect, it } from 'vitest';
import { classifyLeadIntake } from './lead-classifier';

describe('classifyLeadIntake', () => {
  it('detects hot purchase-ready leads', () => {
    const r = classifyLeadIntake({ latestMessage: 'אני רוצה להירשם, איך משלמים?' });
    expect(r.inquiryType).toBe('purchase_ready');
    expect(r.productInterest).toBe('digital_program');
    expect(r.intakeSegment).toBe('hot_sales');
    expect(r.handoffReason).toContain('כוונת רכישה');
  });

  it('detects pricing and nurture leads', () => {
    const r = classifyLeadIntake({ firstMessage: 'מה המחיר של התוכנית וכמה זה עולה?' });
    expect(r.inquiryType).toBe('pricing');
    expect(r.productInterest).toBe('digital_program');
    expect(r.intakeSegment).toBe('needs_nurture');
    expect(r.suggestedNextAction).toContain('מסגרת ערך');
  });

  it('keeps financing questions under the core program until a rep clarifies otherwise', () => {
    const r = classifyLeadIntake({ latestMessage: 'יש לי שאלה על משכנתא והון עצמי לעסקה' });
    expect(r.inquiryType).toBe('financing');
    expect(r.productInterest).toBe('digital_program');
  });

  it('detects investor mentorship interest', () => {
    const r = classifyLeadIntake({ latestMessage: 'אני מחפש ליווי משקיעים לעסקאות נדלן' });
    expect(r.productInterest).toBe('investor_mentorship');
  });

  it('detects contractor group purchase interest', () => {
    const r = classifyLeadIntake({ latestMessage: 'יש פרטים על קבוצת רכישה מקבלן?' });
    expect(r.productInterest).toBe('contractor_group_purchase');
  });

  it('detects personal consultation interest', () => {
    const r = classifyLeadIntake({ latestMessage: 'אפשר לקבוע שיחת ייעוץ אישית?' });
    expect(r.productInterest).toBe('personal_consultation');
  });

  it('detects explicit human handoff need', () => {
    const r = classifyLeadIntake({ latestMessage: 'אפשר שיחה עם נציג בטלפון?' });
    expect(r.intakeSegment).toBe('needs_human');
    expect(r.handoffReason).toBe('הליד ביקש שיחה/נציג אנושי');
  });

  it('detects existing student/support context', () => {
    const r = classifyLeadIntake({ latestMessage: 'אני תלמיד וכבר נרשמתי אבל אין לי גישה' });
    expect(r.inquiryType).toBe('support');
    expect(r.productInterest).toBe('unknown');
    expect(r.intakeSegment).toBe('support_or_existing');
  });

  it('uses metadata/source text as classification evidence', () => {
    const r = classifyLeadIntake({
      source: 'webinar',
      sourceCampaign: 'קורס נדלן למשקיעים מתחילים',
      metadata: { utm_term: 'דירה להשקעה' },
    });
    expect(r.inquiryType).not.toBe('unknown');
    expect(r.matchedKeywords.length).toBeGreaterThan(0);
  });

  it('returns low confidence unknown with no signal', () => {
    const r = classifyLeadIntake({ latestMessage: '' });
    expect(r.inquiryType).toBe('unknown');
    expect(r.confidence).toBe('low');
  });
});
