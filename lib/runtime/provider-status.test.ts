import { describe, expect, it } from 'vitest';
import { extractProviderStatuses, shouldAdvanceStatus } from './provider-status';

const metaReceipt = (statuses: unknown[], extraChange?: unknown) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WABA',
    changes: [
      { field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'P1' }, statuses } },
      ...(extraChange ? [extraChange] : []),
    ],
  }],
});

describe('extractProviderStatuses', () => {
  it('reads a Meta delivery receipt', () => {
    expect(extractProviderStatuses(metaReceipt([{ id: 'wamid.A', status: 'delivered', recipient_id: '9725' }])))
      .toEqual([{ providerMessageId: 'wamid.A', status: 'delivered', errorCode: null, errorMessage: null }]);
  });

  it('keeps the error code and message of a failed send', () => {
    const out = extractProviderStatuses(metaReceipt([{
      id: 'wamid.B', status: 'failed',
      errors: [{ code: 131049, title: 'This message was not delivered to maintain healthy ecosystem engagement.' }],
    }]));
    expect(out[0]).toMatchObject({ status: 'failed', errorCode: 131049 });
    expect(out[0]?.errorMessage).toContain('healthy ecosystem');
  });

  it('reads every change, not only the first', () => {
    const out = extractProviderStatuses(metaReceipt(
      [{ id: 'wamid.1', status: 'sent' }],
      { field: 'messages', value: { statuses: [{ id: 'wamid.2', status: 'read' }] } },
    ));
    expect(out.map((s) => s.providerMessageId)).toEqual(['wamid.1', 'wamid.2']);
  });

  it('returns nothing for a customer message', () => {
    const body = { entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'wamid.C', type: 'text', text: { body: 'שלום' } }] } }] }] };
    expect(extractProviderStatuses(body)).toEqual([]);
  });

  it('accepts the flat WATI shapes', () => {
    expect(extractProviderStatuses({ statuses: [{ message_id: 'w1', status: 'READ' }] })[0]?.status).toBe('read');
    expect(extractProviderStatuses({ message_id: 'w2', status: 'failed', error: { message: 'bad number' } })[0])
      .toMatchObject({ providerMessageId: 'w2', errorMessage: 'bad number' });
  });

  it('ignores junk', () => {
    expect(extractProviderStatuses(null)).toEqual([]);
    expect(extractProviderStatuses({ entry: 'x' })).toEqual([]);
    expect(extractProviderStatuses(metaReceipt([{ status: 'sent' }]))).toEqual([]);
  });
});

describe('shouldAdvanceStatus', () => {
  it('never lets a late delivered overwrite read', () => {
    expect(shouldAdvanceStatus('read', 'delivered')).toBe(false);
    expect(shouldAdvanceStatus('delivered', 'read')).toBe(true);
    expect(shouldAdvanceStatus(null, 'sent')).toBe(true);
    expect(shouldAdvanceStatus('read', 'failed')).toBe(true);
  });
});
