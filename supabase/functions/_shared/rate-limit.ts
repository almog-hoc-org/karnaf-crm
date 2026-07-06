// Webhook rate limiter backed by `check_rate_limit` RPC. Use it before
// performing any work in a public webhook handler. Fails open on RPC
// errors so a degraded rate-limit table can't take down the entire ingress
// path; combined with structured logging this is the right default.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { log } from './logger.ts';

export interface RateLimitOptions {
  key: string;
  windowSeconds: number;
  maxRequests: number;
}

export async function checkRateLimit(
  supabase: SupabaseClient,
  opts: RateLimitOptions,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('check_rate_limit', {
    p_key: opts.key,
    p_window_seconds: opts.windowSeconds,
    p_max_requests: opts.maxRequests,
  });
  if (error) {
    log.warn('rate_limit_rpc_error', { fn: 'rate-limit', err: error.message, key: opts.key });
    return true;
  }
  return Boolean(data);
}

export function clientIdentifier(req: Request): string {
  return req.headers.get('cf-connecting-ip')
      || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || req.headers.get('x-real-ip')
      || 'unknown';
}
