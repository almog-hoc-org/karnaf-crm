import { describe, expect, it } from 'vitest';
import {
  buildCapiEvent,
  buildUserData,
  normalizeEmailForCapi,
  normalizePhoneForCapi,
  sha256Hex,
} from '@lib/runtime/meta-capi';

describe('sha256Hex', () => {
  it('matches a known SHA-256 vector', async () => {
    // echo -n "test@example.com" | sha256sum
    expect(await sha256Hex('test@example.com')).toBe(
      '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b',
    );
  });
});

describe('normalizeEmailForCapi', () => {
  it('trims and lowercases per the Meta spec', () => {
    expect(normalizeEmailForCapi('  Test@Example.COM ')).toBe('test@example.com');
  });

  it('rejects empty and non-email values', () => {
    expect(normalizeEmailForCapi('')).toBeNull();
    expect(normalizeEmailForCapi(null)).toBeNull();
    expect(normalizeEmailForCapi('not-an-email')).toBeNull();
  });
});

describe('normalizePhoneForCapi', () => {
  it('converts Israeli local format to 972 digits', () => {
    expect(normalizePhoneForCapi('050-123-4567')).toBe('972501234567');
    expect(normalizePhoneForCapi('0501234567')).toBe('972501234567');
  });

  it('handles +972 and 00972 prefixes', () => {
    expect(normalizePhoneForCapi('+972501234567')).toBe('972501234567');
    expect(normalizePhoneForCapi('00972501234567')).toBe('972501234567');
  });

  it('rejects short/empty values', () => {
    expect(normalizePhoneForCapi('123')).toBeNull();
    expect(normalizePhoneForCapi(null)).toBeNull();
  });
});

describe('buildUserData', () => {
  it('hashes em/ph and passes fbp/fbc through', async () => {
    const userData = await buildUserData({
      email: 'Test@Example.com',
      phone: '0501234567',
      fbp: 'fb.1.1700000000.111',
      fbc: 'fb.1.1700000000.IwAR123',
    });
    expect(userData.em).toEqual([await sha256Hex('test@example.com')]);
    expect(userData.ph).toEqual([await sha256Hex('972501234567')]);
    expect(userData.fbp).toBe('fb.1.1700000000.111');
    expect(userData.fbc).toBe('fb.1.1700000000.IwAR123');
  });

  it('omits keys without signal', async () => {
    const userData = await buildUserData({ email: null, phone: 'abc' });
    expect(userData).toEqual({});
  });
});

describe('buildCapiEvent', () => {
  it('builds a Lead event', () => {
    const event = buildCapiEvent({
      eventName: 'Lead',
      eventId: 'evt-1',
      eventTimeSec: 1753272000.9,
      sourceUrl: 'https://karnafnadlan.com/course',
      userData: { em: ['x'] },
    });
    expect(event).toEqual({
      event_name: 'Lead',
      event_time: 1753272000,
      event_id: 'evt-1',
      action_source: 'website',
      user_data: { em: ['x'] },
      event_source_url: 'https://karnafnadlan.com/course',
    });
  });

  it('builds a Purchase event with value/currency', () => {
    const event = buildCapiEvent({
      eventName: 'Purchase',
      eventId: 'purchase-ord1',
      eventTimeSec: 1753272000,
      userData: { ph: ['y'] },
      value: 5490,
      currency: 'ILS',
    });
    expect(event.custom_data).toEqual({ value: 5490, currency: 'ILS' });
    expect(event.event_source_url).toBeUndefined();
  });
});
