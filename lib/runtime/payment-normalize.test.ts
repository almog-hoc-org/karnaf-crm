import { describe, expect, it } from 'vitest';
import { normalizePaymentPayload, parseFormEncoded } from '@lib/runtime/payment-normalize';

describe('normalizePaymentPayload — grow', () => {
  it('maps an approved Grow charge onto the generic shape', () => {
    const normalized = normalizePaymentPayload('grow', {
      data: {
        transactionId: 'TX-123',
        payerPhone: '0501234567',
        payerEmail: 'Buyer@Example.com',
        productCode: 'course_5490',
        statusCode: '2',
        sum: '5490',
        pageCode: 'checkout-course',
      },
    });
    expect(normalized).toEqual({
      order_id: 'TX-123',
      phone: '0501234567',
      email: 'Buyer@Example.com',
      product_code: 'course_5490',
      payment_status: 'paid',
      amount: 5490,
      currency: 'ILS',
      provider: 'grow',
      link_source: 'checkout-course',
    });
  });

  it('maps pending and failed status codes', () => {
    expect(normalizePaymentPayload('grow', { data: { statusCode: '1' } }).payment_status).toBe('pending');
    expect(normalizePaymentPayload('grow', { data: { statusCode: '3' } }).payment_status).toBe('failed');
  });

  it('reads flat payloads when there is no data envelope', () => {
    const normalized = normalizePaymentPayload('grow', {
      transactionId: 'TX-9',
      statusCode: '2',
      sum: 100,
    });
    expect(normalized.order_id).toBe('TX-9');
    expect(normalized.payment_status).toBe('paid');
    expect(normalized.amount).toBe(100);
  });
});

describe('normalizePaymentPayload — generic fallback', () => {
  it('keeps the existing alias behavior for unknown providers', () => {
    const normalized = normalizePaymentPayload(null, {
      transaction_id: 'ORD-7',
      customer_phone: '0521111111',
      email: 'x@y.co.il',
      product: 'digital_program',
      status: 'Completed',
      amount: '1200.5',
      provider: 'cardcom',
      source: 'wa-link',
    });
    expect(normalized).toEqual({
      order_id: 'ORD-7',
      phone: '0521111111',
      email: 'x@y.co.il',
      product_code: 'digital_program',
      payment_status: 'completed',
      amount: 1200.5,
      currency: 'ILS',
      provider: 'cardcom',
      link_source: 'wa-link',
    });
  });

  it('defaults sanely on an empty payload', () => {
    const normalized = normalizePaymentPayload('someprovider', {});
    expect(normalized.payment_status).toBe('unknown');
    expect(normalized.provider).toBe('someprovider');
    expect(normalized.order_id).toBeNull();
  });
});

describe('parseFormEncoded', () => {
  it('parses url-encoded bodies into a flat object', () => {
    expect(parseFormEncoded('transactionId=TX-1&sum=5490&payerPhone=0501234567')).toEqual({
      transactionId: 'TX-1',
      sum: '5490',
      payerPhone: '0501234567',
    });
  });
});
