import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAFETY_NET,
  isAckWorthyFailure,
  resolveSafetyNet,
  shouldSendGenericAck,
} from './generic-ack';

describe('resolveSafetyNet', () => {
  it('falls back to defaults on missing/invalid config', () => {
    expect(resolveSafetyNet(null)).toEqual(DEFAULT_SAFETY_NET);
    expect(resolveSafetyNet({ oncePerHours: 0, ackText: '  ' })).toEqual(DEFAULT_SAFETY_NET);
  });

  it('honors explicit overrides', () => {
    const cfg = resolveSafetyNet({ enabled: false, ackText: 'שלום', oncePerHours: 6 });
    expect(cfg.enabled).toBe(false);
    expect(cfg.ackText).toBe('שלום');
    expect(cfg.oncePerHours).toBe(6);
  });
});

describe('isAckWorthyFailure', () => {
  it('covers the model-execution failure taxonomy', () => {
    for (const s of ['model_disabled', 'circuit_open', 'openai_error:429', 'gemini_timeout',
      'openai_empty_content', 'provider_exception', 'provider_send_error', 'validation_blocked']) {
      expect(isAckWorthyFailure(s), s).toBe(true);
    }
  });

  it('ignores successful and non-failure statuses', () => {
    for (const s of ['executed', 'sent', 'skipped', 'no_send']) {
      expect(isAckWorthyFailure(s), s).toBe(false);
    }
  });
});

describe('shouldSendGenericAck', () => {
  const now = new Date('2026-07-21T12:00:00Z');
  const config = DEFAULT_SAFETY_NET;

  it('sends on first failure with no prior ack', () => {
    expect(shouldSendGenericAck({ config, executionStatus: 'model_disabled', lastAckAt: null, now })).toBe(true);
  });

  it('suppresses a second ack inside the window', () => {
    expect(shouldSendGenericAck({
      config, executionStatus: 'circuit_open',
      lastAckAt: '2026-07-21T11:00:00Z', now,
    })).toBe(false);
  });

  it('sends again once the window elapsed (boundary inclusive)', () => {
    expect(shouldSendGenericAck({
      config, executionStatus: 'openai_error',
      lastAckAt: '2026-07-20T12:00:00Z', now,
    })).toBe(true);
  });

  it('never sends when disabled or on non-failure status', () => {
    expect(shouldSendGenericAck({
      config: { ...config, enabled: false },
      executionStatus: 'model_disabled', lastAckAt: null, now,
    })).toBe(false);
    expect(shouldSendGenericAck({ config, executionStatus: 'executed', lastAckAt: null, now })).toBe(false);
  });

  it('treats an unparsable stamp as no stamp', () => {
    expect(shouldSendGenericAck({
      config, executionStatus: 'model_disabled', lastAckAt: 'not-a-date', now,
    })).toBe(true);
  });
});
