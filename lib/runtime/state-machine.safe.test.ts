import { describe, expect, it } from 'vitest';
import { safeTransition } from './state-machine';

describe('safeTransition (the production helper)', () => {
  it('keeps the current status for a missing or identical target', () => {
    expect(safeTransition('new', null)).toBe('new');
    expect(safeTransition('new', undefined)).toBe('new');
    expect(safeTransition('new', '')).toBe('new');
    expect(safeTransition('new', 'new')).toBe('new');
  });

  it('applies a legal transition and refuses an illegal one', () => {
    expect(safeTransition('new', 'first_contact_sent')).toBe('first_contact_sent');
    expect(safeTransition('new', 'won')).toBe('new');
    expect(safeTransition('won', 'new')).toBe('won');
    expect(safeTransition('not_a_status', 'new')).toBe('not_a_status');
  });
});
