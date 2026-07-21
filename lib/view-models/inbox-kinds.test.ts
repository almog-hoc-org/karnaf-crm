import { describe, expect, it } from 'vitest';
import { ATTENTION_KINDS, KIND_LABELS, KIND_LANES } from './inbox-kinds';

describe('inbox kind registry', () => {
  it('every RPC kind has a Hebrew label', () => {
    for (const kind of ATTENTION_KINDS) {
      expect(KIND_LABELS[kind], kind).toBeTruthy();
    }
  });

  it('every RPC kind is assigned to a lane', () => {
    for (const kind of ATTENTION_KINDS) {
      expect(['reply', 'call', 'risk', 'ops'], kind).toContain(KIND_LANES[kind]);
    }
  });

  it('awaiting-reply kinds land in the reply lane', () => {
    expect(KIND_LANES.awaiting_reply).toBe('reply');
    expect(KIND_LANES.mia_reply).toBe('reply');
  });
});
