export interface HandoffActiveHours {
  start: string;
  end: string;
  timezone: string;
  /** JavaScript day indexes: Sunday=0 ... Saturday=6. Defaults to Israel work week, Sun-Thu. */
  workingDays?: number[];
}

export interface HumanHandoffSchedule {
  isOpenNow: boolean;
  dueAtIso: string;
  priorityLevel: number;
  customerText: string;
  reason: string;
  nextOpenLabel: string | null;
}

const DEFAULT_WORKING_DAYS = [0, 1, 2, 3, 4];

export function buildHumanHandoffSchedule(now: Date, activeHours: HandoffActiveHours): HumanHandoffSchedule {
  const isOpenNow = isWithinWorkingHours(now, activeHours);
  if (isOpenNow) {
    return {
      isOpenNow: true,
      dueAtIso: now.toISOString(),
      priorityLevel: 1,
      customerText: 'מעולה, העברתי לנציג אנושי. נחזור אליך כאן בהקדם.',
      reason: 'לקוח ביקש מעבר לנציג אנושי בוואטסאפ',
      nextOpenLabel: null,
    };
  }

  const nextOpen = findNextOpening(now, activeHours);
  const nextOpenLabel = formatHebrewLocalTime(nextOpen, activeHours.timezone);
  return {
    isOpenNow: false,
    dueAtIso: nextOpen.toISOString(),
    priorityLevel: 2,
    customerText: `מעולה, העברתי לנציג אנושי. אנחנו לא בשעות הפעילות כרגע, נחזור אליך כאן בשעות הפעילות הקרובות (${nextOpenLabel}).`,
    reason: `לקוח ביקש נציג אנושי מחוץ לשעות הפעילות — לטיפול החל מ-${nextOpenLabel}`,
    nextOpenLabel,
  };
}

export function isWithinWorkingHours(now: Date, activeHours: HandoffActiveHours): boolean {
  const dayIndex = getDayOfWeekInTz(now, activeHours.timezone);
  if (!normaliseWorkingDays(activeHours).includes(dayIndex)) return false;
  const start = parseHourMinute(activeHours.start);
  const end = parseHourMinute(activeHours.end);
  if (start == null || end == null) return true;
  const minutesNow = getMinutesOfDayInTz(now, activeHours.timezone);
  if (minutesNow == null) return true;
  if (start <= end) return minutesNow >= start && minutesNow < end;
  return minutesNow >= start || minutesNow < end;
}

export function findNextOpening(now: Date, activeHours: HandoffActiveHours): Date {
  const start = parseHourMinute(activeHours.start) ?? 9 * 60;
  const parts = getZonedParts(now, activeHours.timezone);
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const candidateDate = addDaysToLocalDate(parts, dayOffset);
    const candidateDay = getDayOfWeekForLocalDate(candidateDate.year, candidateDate.month, candidateDate.day);
    if (!normaliseWorkingDays(activeHours).includes(candidateDay)) continue;
    const candidate = zonedTimeToUtc({
      year: candidateDate.year,
      month: candidateDate.month,
      day: candidateDate.day,
      hour: Math.floor(start / 60),
      minute: start % 60,
    }, activeHours.timezone);
    if (candidate.getTime() > now.getTime() + 1000) return candidate;
  }
  return new Date(now.getTime() + 24 * 60 * 60_000);
}

function normaliseWorkingDays(activeHours: HandoffActiveHours): number[] {
  const days = activeHours.workingDays?.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return days?.length ? [...new Set(days)] : DEFAULT_WORKING_DAYS;
}

function parseHourMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function getMinutesOfDayInTz(date: Date, timezone: string): number | null {
  const parts = getZonedParts(date, timezone);
  if (!Number.isFinite(parts.hour) || !Number.isFinite(parts.minute)) return null;
  return parts.hour * 60 + parts.minute;
}

function getDayOfWeekInTz(date: Date, timezone: string): number {
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: timezone }).format(date);
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(weekday);
}

function getZonedParts(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const rawHour = get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: get('minute'),
  };
}

function addDaysToLocalDate(parts: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function getDayOfWeekForLocalDate(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay();
}

function zonedTimeToUtc(parts: { year: number; month: number; day: number; hour: number; minute: number }, timezone: string): Date {
  const utcGuess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0));
  const actual = getZonedParts(utcGuess, timezone);
  const targetMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  const actualMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0);
  return new Date(utcGuess.getTime() - (actualMs - targetMs));
}

function formatHebrewLocalTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: timezone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
