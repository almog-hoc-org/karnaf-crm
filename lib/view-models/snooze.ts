// Snooze presets for the triage flow ("לבדוק שוב בעוד X").
//
// The expiry lands at 06:00 UTC (= 09:00 Israel daylight / 08:00 winter)
// on the target day, so a "בעוד שבוע" lead pops back at the start of the
// working morning instead of the exact minute it was snoozed.

export type SnoozePreset = '3d' | '1w' | '2w' | '1m';

export const SNOOZE_PRESETS: Array<{ key: SnoozePreset; label: string }> = [
  { key: '3d', label: '3 ימים' },
  { key: '1w', label: 'שבוע' },
  { key: '2w', label: 'שבועיים' },
  { key: '1m', label: 'חודש' },
];

const PRESET_DAYS: Record<SnoozePreset, number> = { '3d': 3, '1w': 7, '2w': 14, '1m': 30 };

/** Compute the snooze expiry ISO for a preset, relative to `nowMs`. */
export function computeSnoozeUntil(preset: SnoozePreset, nowMs: number): string {
  const target = new Date(nowMs + PRESET_DAYS[preset] * 24 * 3600 * 1000);
  target.setUTCHours(6, 0, 0, 0);
  return target.toISOString();
}

/** Convert a yyyy-mm-dd date-input value to the same morning-anchored ISO. */
export function snoozeUntilFromDate(dateInput: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) return null;
  const ms = Date.parse(`${dateInput}T06:00:00.000Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}
