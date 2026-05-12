// Loads authorised product claims that the AI prompt can reference. The
// rows live in `product_claims` (migration 021); this helper fetches the
// active set for a product, ranked by weight, and shapes them into a
// compact prompt-ready string.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface ProductClaim {
  claim_type: string;
  hebrew_text: string;
  weight: number;
}

const DEFAULT_LIMIT = 12;

export async function loadProductClaims(
  supabase: SupabaseClient,
  productCode: string,
  limit: number = DEFAULT_LIMIT,
): Promise<ProductClaim[]> {
  const { data, error } = await supabase
    .from('product_claims')
    .select('claim_type, hebrew_text, weight')
    .eq('product_code', productCode)
    .eq('is_active', true)
    .order('weight', { ascending: false })
    .limit(limit);
  if (error || !Array.isArray(data)) return [];
  return data.map((row) => ({
    claim_type: String(row.claim_type ?? 'feature'),
    hebrew_text: String(row.hebrew_text ?? ''),
    weight: Number(row.weight ?? 0),
  })).filter((c) => c.hebrew_text.length > 0);
}

export function formatClaimsForPrompt(claims: ProductClaim[]): string[] {
  if (!claims.length) return [];
  const grouped: Record<string, string[]> = {};
  for (const c of claims) {
    if (!grouped[c.claim_type]) grouped[c.claim_type] = [];
    grouped[c.claim_type]!.push(c.hebrew_text);
  }
  const lines: string[] = [];
  for (const [type, items] of Object.entries(grouped)) {
    lines.push(`  ${type}:`);
    for (const item of items) lines.push(`    - ${item}`);
  }
  return lines;
}
