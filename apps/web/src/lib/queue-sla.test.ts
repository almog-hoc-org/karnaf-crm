import { describe, expect, it } from 'vitest';
import { computeSlaState } from './queue-sla';

const NOW = Date.parse('2026-05-13T12:00:00Z');

describe('computeSlaState', () => {
  it('returns ok when createdAt is null', () => {
    expect(computeSlaState('first_response_due', null, NOW).state).toBe('ok');
  });

  it('returns ok when queue type has no SLA mapping', () => {
    const created = new Date(NOW - 24 * 60 * 60_000).toISOString();
    expect(computeSlaState('unknown_type', created, NOW).state).toBe('ok');
  });

  it('returns ok for fresh items under 50% of SLA target', () => {
    const created = new Date(NOW - 10 * 60_000).toISOString();
    expect(computeSlaState('first_response_due', created, NOW).state).toBe('ok');
  });

  it('returns warning between 50% and 100% of SLA target', () => {
    const created = new Date(NOW - 20 * 60_000).toISOString();
    expect(computeSlaState('first_response_due', created, NOW).state).toBe('warning');
  });

  it('returns overdue past 100% of SLA target', () => {
    const created = new Date(NOW - 45 * 60_000).toISOString();
    expect(computeSlaState('first_response_due', created, NOW).state).toBe('overdue');
  });

  it('sla_risk is always overdue (zero SLA target)', () => {
    const created = new Date(NOW - 30_000).toISOString();
    expect(computeSlaState('sla_risk', created, NOW).state).toBe('overdue');
  });

  it('reports ageMinutes and targetMinutes', () => {
    const created = new Date(NOW - 90 * 60_000).toISOString();
    const r = computeSlaState('hot_lead', created, NOW);
    expect(r.ageMinutes).toBe(90);
    expect(r.targetMinutes).toBe(60);
    expect(r.state).toBe('overdue');
  });
});
