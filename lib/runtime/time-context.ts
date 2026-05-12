// Pure helper for building a "current time + business hours + idle window"
// snapshot that the AI prompt can present to the model. Mirrored by
// supabase/functions/_shared/time-context.ts (Deno).

export interface ActiveHours {
  start: string;
  end: string;
  timezone: string;
}

export interface TimeContextInput {
  now: Date;
  lastInboundAt: string | null;
  activeHours: ActiveHours;
}

export interface TimeContext {
  currentTimeIso: string;
  dayOfWeek: string;
  isBusinessHours: boolean;
  isAfterHours: boolean;
  isWeekend: boolean;
  minutesSinceLastInbound: number | null;
  idleBucket: 'fresh' | 'short' | 'medium' | 'long' | 'cold' | null;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function buildTimeContext(input: TimeContextInput): TimeContext {
  const { now, lastInboundAt, activeHours } = input;
  const dayIndex = getDayOfWeekInTz(now, activeHours.timezone);
  const dayOfWeek = DAY_NAMES[dayIndex] ?? 'Unknown';
  const isWeekend = dayIndex === 5 || dayIndex === 6;
  const isBusinessHours = isWithinActiveHours(now, activeHours);
  const minutesSinceLastInbound = computeMinutesSince(now, lastInboundAt);
  return {
    currentTimeIso: now.toISOString(),
    dayOfWeek,
    isBusinessHours,
    isAfterHours: !isBusinessHours,
    isWeekend,
    minutesSinceLastInbound,
    idleBucket: bucketIdle(minutesSinceLastInbound),
  };
}

function getDayOfWeekInTz(now: Date, timezone: string): number {
  try {
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(now);
    const idx = DAY_NAMES.indexOf(weekday);
    return idx >= 0 ? idx : now.getUTCDay();
  } catch {
    return now.getUTCDay();
  }
}

function isWithinActiveHours(now: Date, activeHours: ActiveHours): boolean {
  const start = parseHourMinute(activeHours.start);
  const end = parseHourMinute(activeHours.end);
  if (start == null || end == null) return true;
  const minutesNow = getMinutesOfDayInTz(now, activeHours.timezone);
  if (minutesNow == null) return true;
  if (start <= end) return minutesNow >= start && minutesNow < end;
  return minutesNow >= start || minutesNow < end;
}

function parseHourMinute(raw: string): number | null {
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function getMinutesOfDayInTz(now: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    const m = Number(parts.find((p) => p.type === 'minute')?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  } catch {
    return null;
  }
}

function computeMinutesSince(now: Date, lastInboundAt: string | null): number | null {
  if (!lastInboundAt) return null;
  const t = Date.parse(lastInboundAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 60000));
}

function bucketIdle(minutes: number | null): TimeContext['idleBucket'] {
  if (minutes == null) return null;
  if (minutes < 5) return 'fresh';
  if (minutes < 60) return 'short';
  if (minutes < 6 * 60) return 'medium';
  if (minutes < 24 * 60) return 'long';
  return 'cold';
}

export function formatTimeContextForPrompt(ctx: TimeContext, timezone: string): string[] {
  const lines: string[] = [];
  const localTime = formatLocal(ctx.currentTimeIso, timezone);
  lines.push(`Current time: ${localTime} ${timezone} (${ctx.dayOfWeek}).`);
  lines.push(
    `Business hours: ${ctx.isBusinessHours ? 'within' : 'outside'}; weekend: ${ctx.isWeekend ? 'yes' : 'no'}.`,
  );
  if (ctx.minutesSinceLastInbound != null) {
    lines.push(
      `Lead last inbound ${ctx.minutesSinceLastInbound} minutes ago (idle bucket: ${ctx.idleBucket}).`,
    );
  } else {
    lines.push('Lead has no prior inbound (first contact).');
  }
  return lines;
}

function formatLocal(iso: string, timezone: string): string {
  try {
    const date = new Date(iso);
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(date);
  } catch {
    return iso;
  }
}
