/**
 * The workout model.
 *
 * Callers send loose, human-friendly JSON; `normalizeWorkout` turns it into the
 * strict shape stored in D1 and consumed by the FIT encoder. Everything the
 * caller may get wrong is reported as a `WorkoutError` carrying the JSON path,
 * so an MCP client sees "steps[1].steps[0].target_pace_km[0]: ..." rather than
 * a bare "invalid input".
 */

import {
  METRES_PER_MILE,
  METRES_PER_YARD,
  WorkoutError,
  fail,
  paceToSpeed,
  parseDate,
  parseInteger,
  parseNumber,
  parseRange,
  parseSeconds,
} from './units';

export { WorkoutError };

// ---------------------------------------------------------------------------
// Normalized types
// ---------------------------------------------------------------------------

export type Sport = 'running' | 'cycling' | 'swimming' | 'walking' | 'hiking' | 'rowing' | 'training' | 'generic';

export const SPORTS: readonly Sport[] = [
  'running', 'cycling', 'swimming', 'walking', 'hiking', 'rowing', 'training', 'generic',
];

export type Intensity = 'warmup' | 'active' | 'interval' | 'rest' | 'recovery' | 'cooldown';

export const INTENSITIES: readonly Intensity[] = ['warmup', 'active', 'interval', 'rest', 'recovery', 'cooldown'];

/** Heart rate as absolute bpm or a percentage of max HR. */
export type HrValue = { unit: 'bpm' | 'percent'; value: number };

/** Power as absolute watts or a percentage of FTP. */
export type PowerValue = { unit: 'watts' | 'percent'; value: number };

export type Duration =
  | { type: 'open' }
  | { type: 'time'; seconds: number }
  | { type: 'distance'; meters: number }
  | { type: 'calories'; calories: number }
  | { type: 'reps'; reps: number }
  | { type: 'hr_above' | 'hr_below'; hr: HrValue }
  | { type: 'power_above' | 'power_below'; power: PowerValue };

export type ZoneMetric = 'heart_rate' | 'pace' | 'power' | 'cadence';

export type Target =
  | { type: 'open' }
  | { type: 'zone'; metric: ZoneMetric; zone: number }
  | { type: 'heart_rate'; low: HrValue | null; high: HrValue | null }
  /** Speed in m/s. `unit` records how the caller wrote it, for display only. */
  | { type: 'speed'; low: number | null; high: number | null; unit: 'km' | 'mi' }
  | { type: 'power'; low: PowerValue | null; high: PowerValue | null }
  | { type: 'cadence'; low: number | null; high: number | null };

export type Step =
  | { kind: 'repeat'; times: number; steps: Step[] }
  | { kind: 'step'; name?: string; notes?: string; intensity: Intensity; duration: Duration; target: Target };

export type Workout = {
  version: 1;
  id: string;
  date: string;
  name: string;
  sport: Sport;
  notes?: string;
  steps: Step[];
  updated_at: string;
};

/** A workout as accepted from a caller: no id, no timestamps. */
export type WorkoutInput = Omit<Workout, 'version' | 'id' | 'updated_at'>;

export const MAX_STEPS = 200;
export const MAX_REPEAT_DEPTH = 3;

// ---------------------------------------------------------------------------
// Field tables
// ---------------------------------------------------------------------------

/** Duration keys, in the order they are reported when a caller sets two. */
const DURATION_KEYS = [
  'goal_s', 'goal_time', 'goal_meters', 'goal_km', 'goal_miles', 'goal_yards',
  'goal_calories', 'goal_reps', 'until_hr_above', 'until_hr_below',
  'until_watts_above', 'until_watts_below',
] as const;

const TARGET_KEYS = [
  'target_pace_km', 'target_pace_miles', 'target_heart_rate', 'target_watts',
  'target_cadence', 'target_zone', 'target_hr_zone', 'target_pace_zone',
  'target_power_zone', 'target_cadence_zone',
] as const;

const STEP_KEYS = new Set<string>([
  'name', 'notes', 'intensity', ...DURATION_KEYS, ...TARGET_KEYS,
]);

const REPEAT_KEYS = new Set<string>(['repeat', 'times', 'type', 'steps', 'name', 'notes']);

/** Keyword -> intensity, used when the caller does not say. */
const INTENSITY_HINTS: ReadonlyArray<[RegExp, Intensity]> = [
  [/\b(warm ?up|warm)\b/i, 'warmup'],
  [/\b(cool ?down|cool)\b/i, 'cooldown'],
  [/\b(recover(y|ies)?|float|easy jog)\b/i, 'recovery'],
  [/\b(rest|walk|standing|jog back)\b/i, 'rest'],
  [/\b(interval|rep|fast|hard|on|surge)\b/i, 'interval'],
];

// ---------------------------------------------------------------------------
// Value parsers
// ---------------------------------------------------------------------------

/** `150` or `"150"` -> bpm; `"85%"` -> percent of max HR. */
function parseHr(value: unknown, path: string): HrValue {
  if (typeof value === 'string' && value.trim().endsWith('%')) {
    return { unit: 'percent', value: parseInteger(value.trim().slice(0, -1), path, 1, 100) };
  }
  return { unit: 'bpm', value: parseInteger(value, path, 20, 255) };
}

/** `250` -> watts; `"95%"` -> percent of FTP. */
function parsePower(value: unknown, path: string): PowerValue {
  if (typeof value === 'string' && value.trim().endsWith('%')) {
    return { unit: 'percent', value: parseInteger(value.trim().slice(0, -1), path, 1, 1000) };
  }
  return { unit: 'watts', value: parseInteger(value, path, 1, 2000) };
}

const parseCadence = (value: unknown, path: string): number => parseInteger(value, path, 1, 254);

/**
 * A pace range over `metres` -> a speed range in m/s.
 *
 * Positions mean the same thing as in every other range: the first entry is the
 * floor on effort and the second the ceiling. Since a *lower* pace number is a
 * *higher* speed, that reads as:
 *
 *   ["6:30", "-"]     faster than 6:30 — a floor on speed
 *   ["-", "8:00"]     slower than 8:00 — a ceiling on speed
 *
 * When both ends are given the band is unambiguous whichever way round it is
 * written, so ["4:00", "4:15"] and ["4:15", "4:00"] both mean 4:00-4:15.
 */
function paceRangeToSpeed(value: unknown, path: string, metres: number): { low: number | null; high: number | null } {
  const [first, second] = parseRange(value, path, parseSeconds);

  if (first !== null && second !== null) {
    return { low: paceToSpeed(Math.max(first, second), metres), high: paceToSpeed(Math.min(first, second), metres) };
  }
  return first !== null
    ? { low: paceToSpeed(first, metres), high: null }
    : { low: null, high: paceToSpeed(second as number, metres) };
}

// ---------------------------------------------------------------------------
// Step parsing
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keys the caller actually set (present and not null). */
function setKeys(raw: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys.filter((k) => raw[k] !== undefined && raw[k] !== null);
}

function parseDuration(raw: Record<string, unknown>, path: string): Duration {
  const present = setKeys(raw, DURATION_KEYS);
  if (present.length === 0) return { type: 'open' };
  if (present.length > 1) {
    fail(path, `a step can only have one duration, but ${present.join(' and ')} were both set`);
  }
  const key = present[0];
  const at = `${path}.${key}`;
  const value = raw[key];

  switch (key) {
    case 'goal_s':
    case 'goal_time':
      return { type: 'time', seconds: parseSeconds(value, at) };
    case 'goal_meters':
      return { type: 'distance', meters: parseNumber(value, at) };
    case 'goal_km':
      return { type: 'distance', meters: parseNumber(value, at) * 1000 };
    case 'goal_miles':
      return { type: 'distance', meters: parseNumber(value, at) * METRES_PER_MILE };
    case 'goal_yards':
      return { type: 'distance', meters: parseNumber(value, at) * METRES_PER_YARD };
    case 'goal_calories':
      return { type: 'calories', calories: parseInteger(value, at, 1, 65_535) };
    case 'goal_reps':
      return { type: 'reps', reps: parseInteger(value, at, 1, 1000) };
    case 'until_hr_above':
      return { type: 'hr_above', hr: parseHr(value, at) };
    case 'until_hr_below':
      return { type: 'hr_below', hr: parseHr(value, at) };
    case 'until_watts_above':
      return { type: 'power_above', power: parsePower(value, at) };
    default:
      return { type: 'power_below', power: parsePower(value, at) };
  }
}

const ZONE_METRICS: Record<string, ZoneMetric> = {
  heart_rate: 'heart_rate', hr: 'heart_rate', pace: 'pace', speed: 'pace',
  power: 'power', watts: 'power', cadence: 'cadence',
};

const ZONE_LIMITS: Record<ZoneMetric, number> = { heart_rate: 5, pace: 10, power: 7, cadence: 10 };

function parseZone(value: unknown, path: string, metric: ZoneMetric): Target {
  let zone = value;
  let resolved = metric;
  if (isObject(value)) {
    const type = value.type ?? value.metric;
    if (type !== undefined) {
      const found = ZONE_METRICS[String(type).toLowerCase()];
      if (!found) fail(`${path}.type`, `unknown zone type ${JSON.stringify(type)}, expected one of ${Object.keys(ZONE_METRICS).join(', ')}`);
      resolved = found;
    }
    zone = value.zone ?? value.value;
  }
  return { type: 'zone', metric: resolved, zone: parseInteger(zone, path, 1, ZONE_LIMITS[resolved]) };
}

function parseTarget(raw: Record<string, unknown>, path: string): Target {
  const present = setKeys(raw, TARGET_KEYS);
  if (present.length === 0) return { type: 'open' };
  if (present.length > 1) {
    fail(path, `a step can only have one target, but ${present.join(' and ')} were both set`);
  }
  const key = present[0];
  const at = `${path}.${key}`;
  const value = raw[key];

  switch (key) {
    case 'target_pace_km':
      return { type: 'speed', unit: 'km', ...paceRangeToSpeed(value, at, 1000) };
    case 'target_pace_miles':
      return { type: 'speed', unit: 'mi', ...paceRangeToSpeed(value, at, METRES_PER_MILE) };
    case 'target_heart_rate': {
      const [low, high] = parseRange(value, at, parseHr);
      assertOrdered(low?.value, high?.value, at, value);
      return { type: 'heart_rate', low, high };
    }
    case 'target_watts': {
      const [low, high] = parseRange(value, at, parsePower);
      assertOrdered(low?.value, high?.value, at, value);
      return { type: 'power', low, high };
    }
    case 'target_cadence': {
      const [low, high] = parseRange(value, at, parseCadence);
      assertOrdered(low ?? undefined, high ?? undefined, at, value);
      return { type: 'cadence', low, high };
    }
    case 'target_zone':
      return parseZone(value, at, 'heart_rate');
    case 'target_hr_zone':
      return parseZone(value, at, 'heart_rate');
    case 'target_pace_zone':
      return parseZone(value, at, 'pace');
    case 'target_power_zone':
      return parseZone(value, at, 'power');
    default:
      return parseZone(value, at, 'cadence');
  }
}

function assertOrdered(low: number | undefined, high: number | undefined, path: string, raw: unknown): void {
  if (low !== undefined && high !== undefined && low > high) {
    fail(path, `the low end must not exceed the high end — ${JSON.stringify(raw)} is reversed`);
  }
}

function inferIntensity(name: string | undefined, insideRepeat: boolean): Intensity {
  if (name) {
    for (const [pattern, intensity] of INTENSITY_HINTS) {
      if (pattern.test(name)) return intensity;
    }
  }
  return insideRepeat ? 'interval' : 'active';
}

function parseText(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') fail(path, `expected a string, got ${typeof value}`);
  const text = (value as string).trim();
  if (text.length > max) fail(path, `must be at most ${max} characters`);
  return text;
}

function isRepeat(raw: Record<string, unknown>): boolean {
  return raw.repeat !== undefined || raw.times !== undefined || String(raw.type ?? '').toLowerCase() === 'repeat';
}

function parseStep(value: unknown, path: string, depth: number, insideRepeat: boolean): Step {
  if (!isObject(value)) fail(path, `expected an object describing a step, got ${Array.isArray(value) ? 'an array' : typeof value}`);
  const raw = value as Record<string, unknown>;

  if (isRepeat(raw)) {
    rejectUnknownKeys(raw, REPEAT_KEYS, path);
    if (depth >= MAX_REPEAT_DEPTH) fail(path, `repeats may not nest more than ${MAX_REPEAT_DEPTH} deep`);
    const times = parseInteger(raw.repeat ?? raw.times, `${path}.repeat`, 1, 500);
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
      fail(`${path}.steps`, `a repeat needs at least one step to repeat`);
    }
    const steps = (raw.steps as unknown[]).map((child, i) => parseStep(child, `${path}.steps[${i}]`, depth + 1, true));
    return { kind: 'repeat', times, steps };
  }

  rejectUnknownKeys(raw, STEP_KEYS, path);
  const name = raw.name === undefined || raw.name === null ? undefined : parseText(raw.name, `${path}.name`, 60);
  const notes = raw.notes === undefined || raw.notes === null ? undefined : parseText(raw.notes, `${path}.notes`, 200);

  let intensity: Intensity;
  if (raw.intensity === undefined || raw.intensity === null) {
    intensity = inferIntensity(name, insideRepeat);
  } else {
    const given = String(raw.intensity).toLowerCase() as Intensity;
    if (!INTENSITIES.includes(given)) {
      fail(`${path}.intensity`, `unknown intensity ${JSON.stringify(raw.intensity)}, expected one of ${INTENSITIES.join(', ')}`);
    }
    intensity = given;
  }

  const step: Step = { kind: 'step', intensity, duration: parseDuration(raw, path), target: parseTarget(raw, path) };
  if (name) step.name = name;
  if (notes) step.notes = notes;
  return step;
}

function rejectUnknownKeys(raw: Record<string, unknown>, allowed: Set<string>, path: string): void {
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    fail(path, `unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}; allowed: ${[...allowed].sort().join(', ')}`);
  }
}

/** Steps in a repeat count once each — the repeat itself is one more FIT step. */
export function countSteps(steps: Step[]): number {
  return steps.reduce((n, step) => n + (step.kind === 'repeat' ? 1 + countSteps(step.steps) : 1), 0);
}

// ---------------------------------------------------------------------------
// Workout parsing
// ---------------------------------------------------------------------------

const WORKOUT_KEYS = new Set(['date', 'name', 'sport', 'notes', 'steps']);

export function normalizeWorkout(value: unknown): WorkoutInput {
  if (!isObject(value)) fail('', `expected a workout object, got ${typeof value}`);
  const raw = value as Record<string, unknown>;
  rejectUnknownKeys(raw, WORKOUT_KEYS, '');

  const date = parseDate(raw.date, 'date');

  let sport: Sport = 'running';
  if (raw.sport !== undefined && raw.sport !== null) {
    const given = String(raw.sport).toLowerCase() as Sport;
    if (!SPORTS.includes(given)) {
      fail('sport', `unknown sport ${JSON.stringify(raw.sport)}, expected one of ${SPORTS.join(', ')}`);
    }
    sport = given;
  }

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    fail('steps', `a workout needs at least one step`);
  }
  const steps = (raw.steps as unknown[]).map((step, i) => parseStep(step, `steps[${i}]`, 0, false));

  const total = countSteps(steps);
  if (total > MAX_STEPS) fail('steps', `a workout may have at most ${MAX_STEPS} steps, got ${total}`);

  const name = raw.name === undefined || raw.name === null
    ? `${sport[0].toUpperCase()}${sport.slice(1)} ${date}`
    : parseText(raw.name, 'name', 80) || `${sport} ${date}`;

  const workout: WorkoutInput = { date, name, sport, steps };
  if (raw.notes !== undefined && raw.notes !== null) {
    const notes = parseText(raw.notes, 'notes', 1000);
    if (notes) workout.notes = notes;
  }
  return workout;
}
