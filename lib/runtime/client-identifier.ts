// Mirror of the helper in supabase/functions/_shared/rate-limit.ts so the
// extraction precedence (Cloudflare → forwarded chain → real-ip → unknown)
// is unit-testable without a Deno runtime.

export function clientIdentifier(headers: Pick<Headers, 'get'>): string {
  return headers.get('cf-connecting-ip')
      || headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || headers.get('x-real-ip')
      || 'unknown';
}
