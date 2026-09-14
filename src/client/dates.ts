// A workout date is a day on a calendar, not an instant, so every conversion here
// goes through *local* midnight. `toISOString` would lose a day west of Greenwich.

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

/** A training week runs Monday to Sunday; `getDay()` is 0 for Sunday, so shift it to 6. */
const weekdayIndex = (date: Date): number => (date.getDay() + 6) % 7;

export const startOfWeek = (date: Date): Date => addDays(date, -weekdayIndex(date));
export const endOfWeek = (date: Date): Date => addDays(date, 6 - weekdayIndex(date));

/** Every day from the Monday on or before `from` to the Sunday on or after `to`. */
export function calendarDays(from: string, to: string): Date[] {
  const days: Date[] = [];
  const end = endOfWeek(fromKey(to));
  for (let day = startOfWeek(fromKey(from)); day <= end; day = addDays(day, 1)) days.push(day);
  return days;
}

export const shortDate = (date: Date): string => date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export const longDate = (date: Date): string =>
  date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/** Rounded: across a DST boundary the difference is not a whole number of days. */
export function relativeDate(key: string): string {
  const date = fromKey(key);
  const label = date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const days = Math.round((date.getTime() - startOfToday().getTime()) / 86_400_000);
  if (days === 0) return `${label} · today`;
  if (days === 1) return `${label} · tomorrow`;
  if (days === -1) return `${label} · yesterday`;
  return label;
}
