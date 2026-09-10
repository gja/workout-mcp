/**
 * Dates, always in the athlete's own timezone.
 *
 * Workout dates are plain `YYYY-MM-DD` — a day on a calendar, not an instant —
 * so every conversion here goes through local midnight. `toISOString` would
 * push the date back a day for anyone west of Greenwich.
 */

export const startOfToday = (): Date => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
};

/** Whole days, via `setDate` so the walk survives a DST transition. */
export const addDays = (date: Date, days: number): Date => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

export const toKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const fromKey = (key: string): Date => new Date(`${key}T00:00:00`);

/** `getDay()` is already 0 for Sunday, so the week needs no offset. */
export const sundayOf = (date: Date): Date => addDays(date, -date.getDay());
export const saturdayOf = (date: Date): Date => addDays(date, 6 - date.getDay());

/** Every day from the Sunday on or before `from` to the Saturday on or after `to`. */
export function calendarDays(from: string, to: string): Date[] {
  const days: Date[] = [];
  const end = saturdayOf(fromKey(to));
  for (let day = sundayOf(fromKey(from)); day <= end; day = addDays(day, 1)) days.push(day);
  return days;
}

export const shortDate = (date: Date): string => date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export const longDate = (date: Date): string =>
  date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * "Monday, 12 Sep · tomorrow". Rounded, because the millisecond difference is
 * not a whole number of days across a DST boundary.
 */
export function relativeDate(key: string): string {
  const date = fromKey(key);
  const label = date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const days = Math.round((date.getTime() - startOfToday().getTime()) / 86_400_000);
  if (days === 0) return `${label} · today`;
  if (days === 1) return `${label} · tomorrow`;
  if (days === -1) return `${label} · yesterday`;
  return label;
}
