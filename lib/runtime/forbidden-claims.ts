// Mirror of supabase/functions/_shared/forbidden-claims.ts so the same logic
// is reachable from Vitest. Keep in sync with the Deno copy.

export function containsForbiddenClaim(reply: string, claims: string[]): string | null {
  if (!reply) return null;
  const lower = reply.toLowerCase();
  for (const c of claims) {
    if (!c) continue;
    if (lower.includes(c.toLowerCase())) return c;
  }
  return null;
}
