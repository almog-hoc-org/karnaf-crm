import { describe, expect, it } from 'vitest';
import {
  validateAiDecision,
  extractQuestions,
  jaccardSimilarity,
  findRepeatedQuestion,
  type AiDecisionOutput,
  type PlaybookRef,
} from './ai-validation';

const playbook: PlaybookRef = {
  name: 'qualification',
  forbidden: ['התחייבות לתשואה'],
  allowedNextStatuses: ['responded', 'qualified', 'human_handoff', 'lost'],
};

const FORBIDDEN = ['guaranteed return', 'תשואה מובטחת'];

function baseOutput(overrides: Partial<AiDecisionOutput> = {}): AiDecisionOutput {
  return {
    replyText: 'שלום, רוצה לעזור לך להבין את הצעדים הבאים.',
    intentClassification: 'general',
    leadStatusUpdate: null,
    leadHeatUpdate: null,
    scoreDelta: 0,
    escalateToMia: false,
    escalateToPhoneSales: false,
    createQueueType: null,
    nextActionType: null,
    nextActionDueAt: null,
    notesForMia: null,
    sendMode: 'freeform',
    policyFlags: [],
    playbookName: 'unknown',
    ...overrides,
  };
}

describe('validateAiDecision', () => {
  it('blocks any send when lead is DNC', () => {
    const r = validateAiDecision({
      output: baseOutput(),
      currentStatus: 'first_contact_sent',
      forbiddenClaims: FORBIDDEN,
      playbook,
      maxReplyChars: 900,
      isDoNotContact: true,
      isRemovedByRequest: false,
    });
    expect(r.output.sendMode).toBe('no_send');
    expect(r.output.replyText).toBeNull();
    expect(r.flags).toContain('suppressed_dnc');
  });

  it('rejects illegal state transition (new -> won)', () => {
    const r = validateAiDecision({
      output: baseOutput({ leadStatusUpdate: 'won' }),
      currentStatus: 'new',
      forbiddenClaims: FORBIDDEN,
      playbook,
      maxReplyChars: 900,
      isDoNotContact: false,
      isRemovedByRequest: false,
    });
    expect(r.output.leadStatusUpdate).toBeNull();
    expect(r.flags).toContain('status_transition_illegal');
  });

  it('rejects status outside playbook even if state-machine allows it', () => {
    const r = validateAiDecision({
      output: baseOutput({ leadStatusUpdate: 'do_not_contact' }),
      currentStatus: 'first_contact_sent',
      forbiddenClaims: FORBIDDEN,
      playbook,
      maxReplyChars: 900,
      isDoNotContact: false,
      isRemovedByRequest: false,
    });
    expect(r.output.leadStatusUpdate).toBeNull();
    expect(r.flags).toContain('status_outside_playbook');
  });

  it('clamps scoreDelta to [-25, 25]', () => {
    const r = validateAiDecision({
      output: baseOutput({ scoreDelta: 999 }),
      currentStatus: 'responded',
      forbiddenClaims: FORBIDDEN,
      playbook,
      maxReplyChars: 900,
      isDoNotContact: false,
      isRemovedByRequest: false,
    });
    expect(r.output.scoreDelta).toBe(25);
  });

  it('strips reply containing forbidden claim and forces no_send', () => {
    const r = validateAiDecision({
      output: baseOutput({ replyText: 'אני מבטיח לך תשואה מובטחת.' }),
      currentStatus: 'responded',
      forbiddenClaims: FORBIDDEN,
      playbook,
      maxReplyChars: 900,
      isDoNotContact: false,
      isRemovedByRequest: false,
    });
    expect(r.output.replyText).toBeNull();
    expect(r.output.sendMode).toBe('no_send');
    expect(r.flags.some((f) => f.startsWith('forbidden_claim:'))).toBe(true);
  });

  it('forces phone_escalation queue when escalateToPhoneSales=true', () => {
    const r = validateAiDecision({
      output: baseOutput({ escalateToPhoneSales: true }),
      currentStatus: 'responded',
      forbiddenClaims: FORBIDDEN,
      playbook,
      maxReplyChars: 900,
      isDoNotContact: false,
      isRemovedByRequest: false,
    });
    expect(r.output.createQueueType).toBe('phone_escalation');
    expect(r.output.notesForMia).toBeTruthy();
  });

  it('rejects reply that is itself JSON', () => {
    const r = validateAiDecision({
      output: baseOutput({ replyText: '{"replyText":"oops"}' }),
      currentStatus: 'responded',
      forbiddenClaims: FORBIDDEN,
      playbook,
      maxReplyChars: 900,
      isDoNotContact: false,
      isRemovedByRequest: false,
    });
    expect(r.output.replyText).toBeNull();
    expect(r.output.sendMode).toBe('no_send');
  });

  it('truncates reply to maxReplyChars', () => {
    const long = 'א'.repeat(2000);
    const r = validateAiDecision({
      output: baseOutput({ replyText: long }),
      currentStatus: 'responded',
      forbiddenClaims: FORBIDDEN,
      playbook,
      maxReplyChars: 100,
      isDoNotContact: false,
      isRemovedByRequest: false,
    });
    expect(r.output.replyText?.length).toBe(100);
  });

  it('passes when no recentAiQuestions provided', () => {
    const r = validateAiDecision({
      output: baseOutput({ replyText: 'מה התקציב המשוער שלך?' }),
      currentStatus: 'responded',
      forbiddenClaims: FORBIDDEN,
      playbook,
      maxReplyChars: 900,
      isDoNotContact: false,
      isRemovedByRequest: false,
    });
    expect(r.output.replyText).toBe('מה התקציב המשוער שלך?');
    expect(r.flags.find((f) => f.startsWith('question_repeated'))).toBeUndefined();
  });

  it('blocks reply that re-asks an identical Hebrew question', () => {
    const r = validateAiDecision({
      output: baseOutput({ replyText: 'מה התקציב המשוער שלך?' }),
      currentStatus: 'responded',
      forbiddenClaims: FORBIDDEN,
      playbook,
      maxReplyChars: 900,
      isDoNotContact: false,
      isRemovedByRequest: false,
      recentAiQuestions: ['מה התקציב המשוער שלך?'],
    });
    expect(r.output.replyText).toBeNull();
    expect(r.output.sendMode).toBe('no_send');
    expect(r.flags.some((f) => f.startsWith('question_repeated'))).toBe(true);
  });

  it('blocks reply that re-asks a paraphrased Hebrew question', () => {
    const r = validateAiDecision({
      output: baseOutput({ replyText: 'כמה תקציב יש לך משוער להשקעה?' }),
      currentStatus: 'responded',
      forbiddenClaims: FORBIDDEN,
      playbook,
      maxReplyChars: 900,
      isDoNotContact: false,
      isRemovedByRequest: false,
      recentAiQuestions: ['כמה תקציב משוער יש לך להשקעה?'],
    });
    expect(r.output.replyText).toBeNull();
    expect(r.flags.some((f) => f.startsWith('question_repeated'))).toBe(true);
  });

  it('allows a different question on the same topic', () => {
    const r = validateAiDecision({
      output: baseOutput({ replyText: 'מתי תרצה להתחיל ללמוד?' }),
      currentStatus: 'responded',
      forbiddenClaims: FORBIDDEN,
      playbook,
      maxReplyChars: 900,
      isDoNotContact: false,
      isRemovedByRequest: false,
      recentAiQuestions: ['מה התקציב שלך?'],
    });
    expect(r.output.replyText).toBe('מתי תרצה להתחיל ללמוד?');
    expect(r.flags.find((f) => f.startsWith('question_repeated'))).toBeUndefined();
  });

  it('allows a reply that has no questions even with recentAiQuestions', () => {
    const r = validateAiDecision({
      output: baseOutput({ replyText: 'אשמח לשלוח לך פרטים בהמשך השבוע.' }),
      currentStatus: 'responded',
      forbiddenClaims: FORBIDDEN,
      playbook,
      maxReplyChars: 900,
      isDoNotContact: false,
      isRemovedByRequest: false,
      recentAiQuestions: ['מה התקציב שלך?', 'מתי תרצה להתחיל?'],
    });
    expect(r.output.replyText).toBe('אשמח לשלוח לך פרטים בהמשך השבוע.');
    expect(r.flags.find((f) => f.startsWith('question_repeated'))).toBeUndefined();
  });
});

describe('extractQuestions', () => {
  it('returns empty array on empty input', () => {
    expect(extractQuestions('')).toEqual([]);
  });

  it('extracts sentences ending with ?', () => {
    expect(extractQuestions('שלום. מה שלומך? אני בסדר.')).toEqual(['מה שלומך?']);
  });

  it('extracts sentences starting with Hebrew question words even without ?', () => {
    const out = extractQuestions('מה התקציב שלך\nאשמח לשמוע');
    expect(out).toContain('מה התקציב שלך');
  });

  it('extracts English questions starting with question words', () => {
    expect(extractQuestions('What is your budget')).toContain('What is your budget');
  });
});

describe('jaccardSimilarity', () => {
  it('returns 0 for disjoint sets', () => {
    expect(jaccardSimilarity(['a', 'b'], ['c', 'd'])).toBe(0);
  });

  it('returns 1 for identical sets', () => {
    expect(jaccardSimilarity(['a', 'b'], ['a', 'b'])).toBe(1);
  });

  it('returns 0 for any empty input', () => {
    expect(jaccardSimilarity([], ['a'])).toBe(0);
    expect(jaccardSimilarity(['a'], [])).toBe(0);
  });
});

describe('findRepeatedQuestion', () => {
  it('returns null when reply has no questions', () => {
    expect(findRepeatedQuestion('שלום, שמח לעזור.', ['מה התקציב?'])).toBeNull();
  });

  it('returns null when recentQuestions empty', () => {
    expect(findRepeatedQuestion('מה התקציב?', [])).toBeNull();
  });

  it('detects high-similarity repeated Hebrew question', () => {
    const r = findRepeatedQuestion('מה התקציב המשוער שלך?', ['מה התקציב המשוער שלך?']);
    expect(r).not.toBeNull();
    expect(r!.score).toBeGreaterThanOrEqual(0.7);
  });
});
