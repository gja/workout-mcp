/**
 * Parsing helpers for the human-friendly values accepted by the workout API:
 * durations ("10:00"), paces ("4:30" per km/mile) and open-ended ranges
 * (`["6:30", "-"]` — "faster than 6:30, no lower bound").
 */

export class WorkoutError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(path ? `${path}: ${message}` : message);
    this.path = path;
  }
}

// The explicit annotation on the binding, rather than only on the arrow, is
// what lets TypeScript treat a `fail(...)` call as unreachable-after and
// narrow the types that follow it.
export const fail: (path: string, message: string) => never = (path, message) => {
  throw new WorkoutError(path, message);
};

/** Values that mean "this end of the range is unbounded". */
const UNSPECIFIED = new Set(['-', '', '*', 'any', 'none', 'null']);

const isUnspecified = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && UNSPECIFIED.has(v.trim().toLowerCase()));

/**
 * Seconds from a number or a "ss" / "mm:ss" / "hh:mm:ss" string.
 * Bare numbers are always seconds, so `goal_s: 300` and `goal_s: "5:00"` agree.
 */
export function parseSeconds(value: unknown, path: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) fail(path, `expected a positive number of seconds, got ${value}`);
    return value;
  }
  if (typeof value !== 'string') fail(path, `expected a number of seconds or a "mm:ss" string, got ${typeof value}`);

  const parts = (value as string).trim().split(':');
  if (parts.length > 3) fail(path, `"${value}" is not a valid duration`);
  let seconds = 0;
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$/.test(part)) fail(path, `"${value}" is not a valid duration (use seconds, "mm:ss" or "hh:mm:ss")`);
    seconds = seconds * 60 + Number(part);
  }
  if (seconds <= 0) fail(path, `duration must be greater than zero`);
  return seconds;
}

/** A positive number, optionally written as a numeric string. */
export function parseNumber(value: unknown, path: string): number {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    fail(path, `expected a positive number, got ${JSON.stringify(value)}`);
  }
  return n as number;
}

export function parseInteger(value: unknown, path: string, min: number, max: number): number {
  const n = parseNumber(value, path);
  if (!Number.isInteger(n) || n < min || n > max) {
    fail(path, `expected a whole number between ${min} and ${max}, got ${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * A range with either end optionally unbounded.
 *
 * Accepts `[low, high]`, a single scalar (both ends equal), or `[low]`.
 * Ends are always ordered low-to-high as written, so for pace — where a
 * lower number is faster — `["6:30", "-"]` reads "faster than 6:30".
 */
export function parseRange<T>(
  value: unknown,
  path: string,
  parseOne: (v: unknown, path: string) => T,
): [T | null, T | null] {
  const pair: [unknown, unknown] = Array.isArray(value)
    ? [value[0], value.length > 1 ? value[1] : null]
    : [value, value];

  if (Array.isArray(value) && value.length > 2) fail(path, `expected at most two values, got ${value.length}`);

  const low = isUnspecified(pair[0]) ? null : parseOne(pair[0], `${path}[0]`);
  const high = isUnspecified(pair[1]) ? null : parseOne(pair[1], `${path}[1]`);
  if (low === null && high === null) fail(path, `at least one end of the range must be specified`);
  return [low, high];
}

export const METRES_PER_MILE = 1609.344;
export const METRES_PER_YARD = 0.9144;

/** Pace ("mm:ss" or seconds) over `metres` -> speed in m/s. */
export function paceToSpeed(paceSeconds: number, metres: number): number {
  return metres / paceSeconds;
}

/** Speed in m/s -> pace in seconds over `metres`. */
export function speedToPace(speed: number, metres: number): number {
  return metres / speed;
}

/** Seconds -> "mm:ss" (or "h:mm:ss" past an hour), for display. */
export function formatDuration(totalSeconds: number): string {
  const total = Math.round(totalSeconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}

/** `YYYY-MM-DD`, rejecting impossible dates like 2026-02-31. */
export function parseDate(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(path, `expected a date as "YYYY-MM-DD", got ${JSON.stringify(value)}`);
  }
  const date = value as string;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    fail(path, `"${date}" is not a real date`);
  }
  return date;
}

/**
 * An instant, normalized to UTC: `2026-09-12T06:30:00.000Z`.
 *
 * A bare `YYYY-MM-DD` is accepted and read as the start of that day, since a
 * caller logging a session after the fact often knows the day and not the
 * hour. Anything else has to be something `Date` understands.
 */
export function parseTimestamp(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    fail(path, `expected an ISO 8601 timestamp, got ${typeof value}`);
  }
  const text = (value as string).trim();
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(ms)) {
    fail(path, `${JSON.stringify(value)} is not a timestamp; use ISO 8601, e.g. "2026-09-12T06:30:00Z"`);
  }
  return new Date(ms).toISOString();
}

/** Today in UTC as `YYYY-MM-DD`. */
export const today = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/** `YYYY-MM-DD` shifted by whole days. */
export function shiftDate(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
