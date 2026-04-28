import { describe, expect, it } from 'vitest';
import { canTransition } from './state-machine';

describe('canTransition', () => {
  it('allows new -> first_contact_sent', () => {
    expect(canTransition('new', 'first_contact_sent')).toBe(true);
  });

  it('rejects new -> won (must traverse the funnel)', () => {
    expect(canTransition('new', 'won')).toBe(false);
  });

  it('allows checkout_pushed -> won and -> payment_pending', () => {
    expect(canTransition('checkout_pushed', 'won')).toBe(true);
    expect(canTransition('checkout_pushed', 'payment_pending')).toBe(true);
  });

  it('allows human_handoff back to active sales states', () => {
    expect(canTransition('human_handoff', 'qualified')).toBe(true);
    expect(canTransition('human_handoff', 'won')).toBe(true);
  });

  it('terminal states reject further transitions', () => {
    expect(canTransition('do_not_contact', 'responded')).toBe(false);
    expect(canTransition('removed_by_request', 'responded')).toBe(false);
    expect(canTransition('active_student', 'responded')).toBe(false);
  });

  it('rejects unknown states defensively', () => {
    expect(canTransition('made_up' as never, 'won' as never)).toBe(false);
  });
});
