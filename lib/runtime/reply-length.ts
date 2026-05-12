// Heat-aware reply length resolver. Cold leads get short reassurances;
// hot leads get richer detail. Mirrored by supabase/functions/_shared/reply-length.ts.

const HEAT_MULTIPLIERS: Record<string, number> = {
  hot: 1.33,
  warm: 1.0,
  cool: 0.78,
  cold: 0.67,
  dormant: 0.67,
};

const HARD_FLOOR = 200;
const HARD_CEILING = 2000;

export function resolveMaxReplyChars(heat: string | null | undefined, baseChars: number): number {
  const base = Math.max(0, Math.trunc(baseChars));
  if (!Number.isFinite(base) || base <= 0) return HARD_FLOOR;
  const lookup = heat ? HEAT_MULTIPLIERS[heat.toLowerCase()] : undefined;
  const multiplier = lookup ?? 1.0;
  const scaled = Math.round(base * multiplier);
  if (scaled < HARD_FLOOR) return HARD_FLOOR;
  if (scaled > HARD_CEILING) return HARD_CEILING;
  return scaled;
}
