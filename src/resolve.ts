/**
 * Resolving a plan into the model the FIT encoder needs.
 *
 * A stored workout keeps the steps as the caller wrote them — `goal_s`,
 * `target_pace_km`, an optional `intensity`. That is a good shape for an API
 * and a poor one for an encoder, which wants a single duration, one or two
 * targets, and speeds in metres per second. This module is where the one
 * becomes the other, and it is the only place that knows FIT's shape.
 *
 * It doubles as the validator: `parseWorkout` resolves every step and throws
 * away the result, so there is one set of rules rather than two.
 */

import {
  METRES_PER_MILE,
  METRES_PER_YARD,
  fail,
  paceToSpeed,
  parseInteger,
  parseNumber,
  parseRange,
  parseSeconds,
} from './units';
import type { Intensity, PlanStep } from './workout';

export type HrValue = { unit: 'bpm' | 'percent'; value: number };
export type PowerValue = { unit: 'watts' | 'percent'; value: number };

export type Duration = { type: 'open' } | { type: 'time'; seconds: number } | { type: 'distance'; meters: number };

export type ZoneMetric = 'heart_rate' | 'pace' | 'power';

export type Target =
  | { type: 'open' }
  | { type: 'zone'; metric: ZoneMetric; zone: number }
  | { type: 'heart_rate'; low: HrValue | null; high: HrValue | null }
  /** Speed in m/s. `unit` records how the caller wrote it, for display only. */
  | { type: 'speed'; low: number | null; high: number | null; unit: 'km' | 'mi' }
  | { type: 'power'; low: PowerValue | null; high: PowerValue | null }
  | { type: 'cadence'; low: number | null; high: number | null };

/** A step in the shape FIT wants: one duration, up to two targets. */
export type ResolvedStep =
  | { kind: 'repeat'; times: number; steps: ResolvedStep[] }
  | {
      kind: 'step';
      name?: string;
      notes?: string;
      intensity: Intensity;
      duration: Duration;
      target: Target;
      secondary_target?: Target;
    };

/** Duration keys, in the order they are reported when a caller sets two. */
export const DURATION_KEYS = ['goal_s', 'goal_meters', 'goal_km', 'goal_miles', 'goal_yards'] as const;

export const TARGET_KEYS = [
  'target_pace_km', 'target_pace_miles', 'target_heart_rate', 'target_watts',
  'target_cadence', 'target_hr_zone', 'target_pace_zone', 'target_power_zone',
] as const;

/** Keyword -> intensity, used when the caller does not say. */
const INTENSITY_HINTS: ReadonlyArray<[RegExp, Intensity]> = [
  [/\b(warm ?up|warm)\b/i, 'warmup'],
  [/\b(cool ?down|cool)\b/i, 'cooldown'],
  [/\b(recover(y|ies)?|float|easy jog)\b/i, 'recovery'],
  [/\b(rest|walk|standing|jog back)\b/i, 'rest'],
  [/\b(interval|rep|fast|hard|on|surge)\b/i, 'interval'],
];

/** Keys the caller actually set (present and not null). */
export function setKeys(raw: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys.filter((k) => raw[k] !== undefined && raw[k] !== null);
}

// ---------------------------------------------------------------------------
// Values
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
    default:
      return { type: 'distance', meters: parseNumber(value, at) * METRES_PER_YARD };
  }
}

/** How many zones each metric has, for a single-zone target. */
/** How many zones each metric has, for a single-zone target. */
const ZONE_COUNT: Record<ZoneMetric, number> = { heart_rate: 5, pace: 10, power: 7 };

/**
 * Zone boundaries as a percentage of the reference value: entry `i` is the
 * bottom of zone `i + 1`, and the last entry is the top of the highest zone.
 *
 * These only come into play for a zone *range*, which FIT cannot express — it
 * stores a single zone number and lets the watch resolve it. A range has to
 * become a percentage band instead, and that needs a zone model. Heart rate
 * uses Garmin's default five zones as a share of max HR; power uses the
 * standard seven-zone model as a share of FTP.
 */
const ZONE_LIMITS: Record<'heart_rate' | 'power', number[]> = {
  heart_rate: [50, 60, 70, 80, 90, 100],
  power: [1, 55, 75, 90, 105, 120, 150, 200],
};

/** A zone number, possibly fractional, as a percentage of the reference. */
function zoneToPercent(zone: number, limits: number[]): number {
  const floor = Math.floor(zone);
  if (floor >= limits.length) return limits[limits.length - 1];
  const fraction = zone - floor;
  return Math.round(limits[floor - 1] + fraction * (limits[floor] - limits[floor - 1]));
}

/**
 * A zone target: either a single zone, which FIT stores natively and the
 * watch resolves against its own configuration, or a range of zone
 * boundaries, which becomes a percentage band.
 *
 * The endpoints of a range are boundaries on a continuous scale, so
 * `["2", "3"]` is exactly zone 2 and all of zones 2 and 3 is `["2", "4"]`.
 */
function parseZone(value: unknown, path: string, metric: ZoneMetric): Target {
  if (!Array.isArray(value)) {
    return { type: 'zone', metric, zone: parseInteger(value, path, 1, ZONE_COUNT[metric]) };
  }

  if (metric === 'pace') {
    fail(
      path,
      'FIT has no percentage speed target, so a pace zone must be a single zone — ' +
        'use target_pace_km with explicit paces for a band',
    );
  }

  const limits = ZONE_LIMITS[metric];
  const top = limits.length;
  const [low, high] = parseRange(value, path, (entry, at) => {
    const zone = parseNumber(entry, at);
    if (zone < 1 || zone > top) fail(at, `expected a zone boundary between 1 and ${top}, got ${JSON.stringify(entry)}`);
    return zone;
  });
  assertOrdered(low ?? undefined, high ?? undefined, path, value);

  const percent = (zone: number | null): { unit: 'percent'; value: number } | null =>
    zone === null ? null : { unit: 'percent', value: zoneToPercent(zone, limits) };

  return metric === 'heart_rate'
    ? { type: 'heart_rate', low: percent(low), high: percent(high) }
    : { type: 'power', low: percent(low), high: percent(high) };
}

/** Which metric a target constrains, for de-duplication and ordering. */
type TargetMetric = 'pace' | 'power' | 'heart_rate' | 'cadence';

/**
 * When a step carries two targets, FIT stores one as primary and one as
 * secondary. This is the order they are chosen in: what you are told to run,
 * then what follows from it. So pace plus cadence makes pace the primary.
 */
const TARGET_PRIORITY: readonly TargetMetric[] = ['pace', 'power', 'heart_rate', 'cadence'];

function targetMetric(target: Target): TargetMetric | null {
  switch (target.type) {
    case 'speed':
      return 'pace';
    case 'power':
      return 'power';
    case 'heart_rate':
      return 'heart_rate';
    case 'cadence':
      return 'cadence';
    case 'zone':
      return target.metric;
    case 'open':
      return null;
  }
}

const priorityOf = (target: Target): number => {
  const metric = targetMetric(target);
  return metric === null ? TARGET_PRIORITY.length : TARGET_PRIORITY.indexOf(metric);
};

function parseOneTarget(key: string, value: unknown, at: string): Target {
  switch (key) {
    case 'target_pace_km':
      return { type: 'speed', unit: 'km', ...paceRangeToSpeed(value, at, 1000) };
    case 'target_pace_miles':
      return { type: 'speed', unit: 'mi', ...paceRangeToSpeed(value, at, METRES_PER_MILE) };
    case 'target_heart_rate': {
      const [low, high] = parseRange(value, at, parseHr);
      assertSameUnit(low, high, at, value);
      assertOrdered(low?.value, high?.value, at, value);
      return { type: 'heart_rate', low, high };
    }
    case 'target_watts': {
      const [low, high] = parseRange(value, at, parsePower);
      assertSameUnit(low, high, at, value);
      assertOrdered(low?.value, high?.value, at, value);
      return { type: 'power', low, high };
    }
    case 'target_cadence': {
      const [low, high] = parseRange(value, at, parseCadence);
      assertOrdered(low ?? undefined, high ?? undefined, at, value);
      return { type: 'cadence', low, high };
    }
    case 'target_hr_zone':
      return parseZone(value, at, 'heart_rate');
    case 'target_pace_zone':
      return parseZone(value, at, 'pace');
    default:
      return parseZone(value, at, 'power');
  }
}

/**
 * A step may carry two targets, which FIT stores as a primary and a
 * secondary — "400m at 4:00/km and 180 spm". They have to constrain different
 * metrics, and the priority list decides which of the two leads.
 */
function parseTargets(raw: Record<string, unknown>, path: string): { target: Target; secondary?: Target } {
  const present = setKeys(raw, TARGET_KEYS);
  if (present.length === 0) return { target: { type: 'open' } };

  const parsed = present.map((key) => ({ key, target: parseOneTarget(key, raw[key], `${path}.${key}`) }));

  // Two targets on the same metric contradict each other.
  const seen = new Map<TargetMetric, string>();
  for (const { key, target } of parsed) {
    const metric = targetMetric(target);
    if (metric === null) continue;
    const already = seen.get(metric);
    if (already) fail(path, `${already} and ${key} both set a ${metric.replace('_', ' ')} target; pick one`);
    seen.set(metric, key);
  }

  if (parsed.length > 2) {
    fail(
      path,
      `a step can have at most two targets — FIT stores a primary and a secondary — but ` +
        `${present.join(', ')} were all set`,
    );
  }

  parsed.sort((a, b) => priorityOf(a.target) - priorityOf(b.target));
  return parsed.length === 1
    ? { target: parsed[0].target }
    : { target: parsed[0].target, secondary: parsed[1].target };
}

/**
 * FIT stores a percentage and an absolute in the same field, telling them
 * apart by magnitude, so a range cannot have one of each: the pair would be
 * read as two unrelated numbers rather than as two ends of one band.
 */
function assertSameUnit(
  low: { unit: string } | null,
  high: { unit: string } | null,
  path: string,
  raw: unknown,
): void {
  if (low && high && low.unit !== high.unit) {
    fail(path, `both ends must use the same unit — ${JSON.stringify(raw)} mixes ${low.unit} and ${high.unit}`);
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


// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const isRepeat = (step: PlanStep): step is Extract<PlanStep, { repeat: number }> => 'repeat' in step;

/**
 * One validated plan step in FIT's shape. Called both when a workout is
 * written, to prove it is sound, and when one is exported.
 */
export function resolveStep(step: PlanStep, path: string, insideRepeat: boolean): ResolvedStep {
  if (isRepeat(step)) {
    return {
      kind: 'repeat',
      times: step.repeat,
      steps: step.steps.map((child, i) => resolveStep(child, `${path}.steps[${i}]`, true)),
    };
  }

  const raw = step as unknown as Record<string, unknown>;
  const intensity = step.intensity ?? inferIntensity(step.name, insideRepeat);
  const { target, secondary } = parseTargets(raw, path);

  const resolved: ResolvedStep = { kind: 'step', intensity, duration: parseDuration(raw, path), target };
  if (secondary) resolved.secondary_target = secondary;
  if (step.name) resolved.name = step.name;
  if (step.notes) resolved.notes = step.notes;
  return resolved;
}

export const resolveSteps = (steps: PlanStep[]): ResolvedStep[] =>
  steps.map((step, i) => resolveStep(step, `steps[${i}]`, false));
