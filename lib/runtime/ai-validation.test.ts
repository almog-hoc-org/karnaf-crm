import { describe, expect, it } from 'vitest';
import { validateAiDecision, type AiDecisionOutput, type PlaybookRef } from './ai-validation';

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
});
