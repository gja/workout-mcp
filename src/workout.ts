/**
 * The workout as the caller writes it.
 *
 * Steps are kept in exactly the shape they arrive in — `goal_s`,
 * `target_pace_km`, an optional `intensity` — and that shape is what gets
 * stored and what reads return. FIT's model, with its single duration and its
 * speeds in metres per second, is derived in `resolve.ts` when a file is
 * actually generated; it is an encoding detail and does not belong in the
 * database or in an API response.
 *
 * Validation is done by resolving: this module checks the shape of a step —
 * its keys, its name, its nesting — and `resolveStep` checks the values, so
 * the rules live in one place rather than two.
 */

import { WorkoutError, fail, parseDate, parseInteger } from './units';
import { DURATION_KEYS, TARGET_KEYS, resolveSteps } from './resolve';

export { WorkoutError };

export type Sport = 'running' | 'cycling' | 'swimming' | 'walking' | 'hiking' | 'rowing' | 'training' | 'generic';

export const SPORTS: readonly Sport[] = [
  'running', 'cycling', 'swimming', 'walking', 'hiking', 'rowing', 'training', 'generic',
];

/**
 * How the sport is done, which a watch uses to pick the activity profile —
 * a treadmill session should not sit waiting for GPS. Names map to the FIT
 * sub-sport enum.
 */
export type SubSport =
  | 'treadmill' | 'street' | 'trail' | 'track' | 'ultra'
  | 'road' | 'mountain' | 'indoor_cycling' | 'spin' | 'virtual_activity'
  | 'lap_swimming' | 'open_water' | 'indoor_rowing' | 'indoor_walking' | 'generic';

export const SUB_SPORTS: readonly SubSport[] = [
  'treadmill', 'street', 'trail', 'track', 'ultra',
  'road', 'mountain', 'indoor_cycling', 'spin', 'virtual_activity',
  'lap_swimming', 'open_water', 'indoor_rowing', 'indoor_walking', 'generic',
];

export type Intensity = 'warmup' | 'active' | 'interval' | 'rest' | 'recovery' | 'cooldown';

export const INTENSITIES: readonly Intensity[] = ['warmup', 'active', 'interval', 'rest', 'recovery', 'cooldown'];

/** A duration or target value as the caller wrote it: `300`, `"5:00"`, `["4:00", "-"]`. */
export type PlanValue = string | number | Array<string | number>;

/** A group of steps, run through several times. */
export type PlanRepeat = { repeat: number; steps: PlanStep[] };

/**
 * One effort. At most one `goal_*` — none means "until the lap button" — and
 * at most two `target_*` on different metrics.
 */
export type PlanEffort = {
  name?: string;
  notes?: string;
  intensity?: Intensity;
} & Partial<Record<(typeof DURATION_KEYS)[number] | (typeof TARGET_KEYS)[number], PlanValue>>;

export type PlanStep = PlanRepeat | PlanEffort;

export type Workout = {
  id: string;
  date: string;
  name: string;
  sport: Sport;
  sub_sport?: SubSport;
  notes?: string;
  /** The caller's own key for this workout, for idempotent re-syncs. */
  external_id?: string;
  steps: PlanStep[];
  /**
   * When the session was actually done, as an ISO instant; absent while it is
   * still only planned.
   *
   * Deliberately not something `parseWorkout` reads: completing a workout is
   * its own verb, so rewriting the plan neither sets it nor clears it by
   * accident. The write paths carry the stored value across themselves.
   */
  completed_at?: string;
  updated_at: string;
};

/** A workout as accepted from a caller: no id, no timestamps. */
export type WorkoutInput = Omit<Workout, 'id' | 'updated_at'>;

export const MAX_STEPS = 200;
export const MAX_REPEAT_DEPTH = 3;

/** `goal_time` is an older spelling; one name is stored. */
const DURATION_ALIASES: Record<string, string> = { goal_time: 'goal_s' };

const STEP_KEYS = new Set<string>([
  'name', 'notes', 'intensity', ...DURATION_KEYS, ...TARGET_KEYS, ...Object.keys(DURATION_ALIASES),
]);

const REPEAT_KEYS = new Set<string>(['repeat', 'times', 'type', 'steps', 'name', 'notes']);

const WORKOUT_KEYS = new Set(['date', 'name', 'sport', 'sub_sport', 'notes', 'external_id', 'steps']);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseText(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') fail(path, `expected a string, got ${typeof value}`);
  const text = (value as string).trim();
  if (text.length > max) fail(path, `must be at most ${max} characters`);
  return text;
}

function rejectUnknownKeys(raw: Record<string, unknown>, allowed: Set<string>, path: string): void {
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    fail(path, `unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}; allowed: ${[...allowed].sort().join(', ')}`);
  }
}

const looksLikeRepeat = (raw: Record<string, unknown>): boolean =>
  raw.repeat !== undefined || raw.times !== undefined || String(raw.type ?? '').toLowerCase() === 'repeat';

/**
 * A step in storable form: the caller's own fields, with the shape checked and
 * the alternative spellings of a repeat collapsed into one. Values are copied
 * across untouched — `resolveStep` is what decides whether they make sense.
 */
function planStep(value: unknown, path: string, depth: number): PlanStep {
  if (!isObject(value)) {
    fail(path, `expected an object describing a step, got ${Array.isArray(value) ? 'an array' : typeof value}`);
  }
  const raw = value as Record<string, unknown>;

  if (looksLikeRepeat(raw)) {
    rejectUnknownKeys(raw, REPEAT_KEYS, path);
    if (depth >= MAX_REPEAT_DEPTH) fail(path, `repeats may not nest more than ${MAX_REPEAT_DEPTH} deep`);
    const repeat = parseInteger(raw.repeat ?? raw.times, `${path}.repeat`, 1, 500);
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
      fail(`${path}.steps`, `a repeat needs at least one step to repeat`);
    }
    return { repeat, steps: (raw.steps as unknown[]).map((child, i) => planStep(child, `${path}.steps[${i}]`, depth + 1)) };
  }

  rejectUnknownKeys(raw, STEP_KEYS, path);
  const step: PlanEffort = {};

  if (raw.name !== undefined && raw.name !== null) {
    const name = parseText(raw.name, `${path}.name`, 60);
    if (name) step.name = name;
  }
  if (raw.notes !== undefined && raw.notes !== null) {
    const notes = parseText(raw.notes, `${path}.notes`, 200);
    if (notes) step.notes = notes;
  }
  if (raw.intensity !== undefined && raw.intensity !== null) {
    const given = String(raw.intensity).toLowerCase() as Intensity;
    if (!INTENSITIES.includes(given)) {
      fail(`${path}.intensity`, `unknown intensity ${JSON.stringify(raw.intensity)}, expected one of ${INTENSITIES.join(', ')}`);
    }
    step.intensity = given;
  }

  for (const key of [...DURATION_KEYS, ...TARGET_KEYS, ...Object.keys(DURATION_ALIASES)]) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    (step as Record<string, unknown>)[DURATION_ALIASES[key] ?? key] = value as PlanValue;
  }

  return step;
}

/** Steps in a repeat count once each — the repeat itself is one more FIT step. */
export function countSteps(steps: PlanStep[]): number {
  return steps.reduce((n, step) => n + ('repeat' in step ? 1 + countSteps(step.steps) : 1), 0);
}

export function parseWorkout(value: unknown): WorkoutInput {
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
  const steps = (raw.steps as unknown[]).map((step, i) => planStep(step, `steps[${i}]`, 0));

  const total = countSteps(steps);
  if (total > MAX_STEPS) fail('steps', `a workout may have at most ${MAX_STEPS} steps, got ${total}`);

  // Resolving proves every value is usable, and throws naming the field that
  // is not. The result is discarded: it is rebuilt when a FIT file is made.
  resolveSteps(steps);

  const name = raw.name === undefined || raw.name === null
    ? `${sport[0].toUpperCase()}${sport.slice(1)} ${date}`
    : parseText(raw.name, 'name', 80) || `${sport} ${date}`;

  const workout: WorkoutInput = { date, name, sport, steps };

  if (raw.sub_sport !== undefined && raw.sub_sport !== null) {
    const given = String(raw.sub_sport).toLowerCase() as SubSport;
    if (!SUB_SPORTS.includes(given)) {
      fail('sub_sport', `unknown sub_sport ${JSON.stringify(raw.sub_sport)}, expected one of ${SUB_SPORTS.join(', ')}`);
    }
    workout.sub_sport = given;
  }
  if (raw.notes !== undefined && raw.notes !== null) {
    const notes = parseText(raw.notes, 'notes', 1000);
    if (notes) workout.notes = notes;
  }
  if (raw.external_id !== undefined && raw.external_id !== null) {
    const externalId = parseText(raw.external_id, 'external_id', 128);
    if (externalId) workout.external_id = externalId;
  }
  return workout;
}
