// Pure payload normalization for payment providers.
//
// payment-webhook's core logic speaks one generic flat shape (order_id /
// phone / email / product_code / payment_status / amount / currency).
// Israeli PSPs post their own field names — this module maps a known
// provider's payload onto the generic shape, so onboarding a PSP is a
// mapping entry here, not new webhook logic. Unknown providers pass
// through the existing generic aliases untouched.
//
// Byte-identical mirror: lib/runtime/payment-normalize.ts (vitest).

export interface NormalizedPayment {
  order_id: string | null;
  phone: string | null;
  email: string | null;
  product_code: string | null;
  payment_status: string;
  amount: number | null;
  currency: string;
  provider: string;
  link_source: string | null;
}

function str(val: unknown): string | null {
  if (typeof val === 'number') return String(val);
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  return trimmed || null;
}

function num(val: unknown): number | null {
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

// Grow (Meshulam infrastructure) webhook: fields arrive under data.*,
// statusCode '2' means an approved charge. The exact field list is
// confirmed against the account's webhook docs at integration time —
// the raw payload is always kept in payment_events.payload_json, so a
// mismatch is diagnosable and correctable after the fact.
const GROW_STATUS: Record<string, string> = {
  '1': 'pending',
  '2': 'paid',
  '3': 'failed',
};

function normalizeGrow(raw: Record<string, unknown>): NormalizedPayment {
  const data = (raw.data && typeof raw.data === 'object' ? raw.data : raw) as Record<string, unknown>;
  const statusCode = str(data.statusCode ?? raw.statusCode ?? data.status ?? raw.status) ?? '';
  return {
    order_id: str(data.transactionId ?? data.asmachta ?? data.transactionToken),
    phone: str(data.payerPhone ?? data.phone),
    email: str(data.payerEmail ?? data.email),
    product_code: str(data.productCode ?? data.product_code ?? data.description),
    payment_status: GROW_STATUS[statusCode] ?? (statusCode || 'unknown').toLowerCase(),
    amount: num(data.sum ?? data.amount),
    currency: str(data.currency) ?? 'ILS',
    provider: 'grow',
    link_source: str(data.pageCode ?? data.processId),
  };
}

/**
 * Map a provider payload onto the generic payment shape. Providers
 * without a dedicated mapping fall through to the generic field aliases
 * payment-webhook always understood.
 */
export function normalizePaymentPayload(
  provider: string | null,
  raw: Record<string, unknown>,
): NormalizedPayment {
  if ((provider ?? '').toLowerCase() === 'grow') return normalizeGrow(raw);

  return {
    order_id: str(raw.order_id ?? raw.transaction_id ?? raw.invoice_id),
    phone: str(raw.phone ?? raw.customer_phone ?? raw.mobile),
    email: str(raw.email),
    product_code: str(raw.product_code ?? raw.product),
    payment_status: (str(raw.payment_status ?? raw.status) ?? 'unknown').toLowerCase(),
    amount: num(raw.amount),
    currency: str(raw.currency) ?? 'ILS',
    provider: str(raw.provider) ?? provider ?? 'unknown',
    link_source: str(raw.link_source ?? raw.source),
  };
}

/** Parse a form-encoded webhook body ("a=1&b=2") into a flat object. */
export function parseFormEncoded(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(body)) out[key] = value;
  return out;
}
