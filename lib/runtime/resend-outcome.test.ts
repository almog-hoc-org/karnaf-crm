import { describe, expect, it } from 'vitest';
import { classifyResendStatus, emailDomain, isPublicMailDomain, shouldPauseSending } from './resend-outcome';

describe('classifyResendStatus', () => {
  it('treats 2xx as a send', () => {
    expect(classifyResendStatus(200)).toBe('ok');
    expect(classifyResendStatus(202)).toBe('ok');
  });

  it('retries rate limits, timeouts, network errors and their outages', () => {
    for (const status of [0, 408, 429, 500, 502, 503]) {
      expect(classifyResendStatus(status)).toBe('retryable');
      expect(shouldPauseSending(classifyResendStatus(status))).toBe(true);
    }
  });

  it('fails the recipient on a rejected payload', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyResendStatus(status)).toBe('fatal');
      expect(shouldPauseSending(classifyResendStatus(status))).toBe(false);
    }
  });
});

describe('emailDomain', () => {
  it('reads the domain from a bare address and from a display-name form', () => {
    expect(emailDomain('hi@karnaf.co.il')).toBe('karnaf.co.il');
    expect(emailDomain('קרנף נדל"ן <Hi@Karnaf.CO.IL>')).toBe('karnaf.co.il');
    expect(emailDomain('not-an-email')).toBe('');
  });
});

describe('isPublicMailDomain', () => {
  it('knows a free mailbox cannot be a sending domain', () => {
    expect(isPublicMailDomain('gmail.com')).toBe(true);
    expect(isPublicMailDomain('walla.co.il')).toBe(true);
    expect(isPublicMailDomain('karnaf.co.il')).toBe(false);
  });
});
