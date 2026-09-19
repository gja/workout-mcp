// Their `workout_doc` read back as our steps. Nothing here is the inverse of the FIT
// file we push: a workout planned on their own site never had one, and this structure
// is what they hold instead. What it drops, and why, is in docs/integrations.md.

import { METRES_PER_YARD, formatDuration } from '../units';
import type { Intensity, PlanEffort, PlanStep, PlanValue } from '../workout';

/** One of their targets: a single value, or the two ends of a ramp. */
type DocTarget = { units?: unknown; value?: unknown; start?: unknown; end?: unknown };

type DocStep = {
  reps?: unknown;
  steps?: unknown;
  /** The step's label, and often a sentence of coaching after it. */
  text?: unknown;
  duration?: unknown;
  distance?: unknown;
  warmup?: unknown;
  cooldown?: unknown;
  recovery?: unknown;
  power?: unknown;
  hr?: unknown;
  pace?: unknown;
  cadence?: unknown;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every value here is a duration, a distance or a target, so none of them may be zero. */
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/** The first line of their label, which is the name; the rest is prose the step has no room for. */
function label(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const first = value.split('\n')[0].trim();
  return first ? first.slice(0, 60) : null;
}

const unitOf = (target: DocTarget): string => String(target.units ?? '').trim().toLowerCase();

/**
 * Their unit spellings, and what each is here. Anything unlisted is dropped rather than
 * read as the nearest thing: a percentage of a threshold we cannot name is not a number.
 */
const POWER_UNITS: Record<string, 'watts' | 'percent'> = {
  w: 'watts',
  watts: 'watts',
  '%ftp': 'percent',
  'ftp%': 'percent',
  percent_ftp: 'percent',
};

/** `%hr` is deliberately absent: theirs is of a threshold, and FIT's is of maximum. */
const HR_UNITS: Record<string, 'bpm' | 'percent'> = {
  bpm: 'bpm',
  '%maxhr': 'percent',
  '%max_hr': 'percent',
  percent_max_hr: 'percent',
};

/** Their pace units, as seconds per kilometre — which is what a pace target is here. */
const PACE_PER_KM: Record<string, (value: number) => number> = {
  'm/s': (value) => 1000 / value,
  mps: (value) => 1000 / value,
  secs_100m: (value) => value * 10,
  's/100m': (value) => value * 10,
  secs_100y: (value) => (value * 1000) / (100 * METRES_PER_YARD),
  secs_km: (value) => value,
  's/km': (value) => value,
  'sec/km': (value) => value,
};

const CADENCE_UNITS = new Set(['rpm', 'spm', 'steps/min', 'strokes/min', 'cadence']);

/** A ramp's ends, or one value standing for both. */
function ends(value: unknown): [number, number] | null {
  if (!isObject(value)) return null;
  const target = value as DocTarget;
  const start = number(target.start);
  const end = number(target.end);
  if (start !== null && end !== null) return [start, end];

  const single = number(target.value) ?? start ?? end;
  return single === null ? null : [single, single];
}

/** `["4:00", "4:15"]`, or the one value where both ends agree. */
const span = (low: string | number, high: string | number): PlanValue => (low === high ? low : [low, high]);

const within = (value: number, min: number, max: number): boolean => value >= min && value <= max;

type Mapped = { key: keyof PlanEffort; value: PlanValue };

/** Out of the range the plan format takes is dropped too: one daft number is not a lost workout. */
function absolute(pair: [number, number], min: number, max: number): PlanValue | null {
  const [low, high] = pair.map(Math.round);
  return within(low, min, max) && within(high, min, max) ? span(low, high) : null;
}

function percent(pair: [number, number], max: number): PlanValue | null {
  const [low, high] = pair.map(Math.round);
  return within(low, 1, max) && within(high, 1, max) ? span(`${low}%`, `${high}%`) : null;
}

function powerTarget(raw: unknown): Mapped | null {
  const pair = ends(raw);
  if (!pair) return null;
  const unit = POWER_UNITS[unitOf(raw as DocTarget)];
  const value = unit === 'watts' ? absolute(pair, 1, 2000) : unit === 'percent' ? percent(pair, 1000) : null;
  return value === null ? null : { key: 'target_watts', value };
}

function hrTarget(raw: unknown): Mapped | null {
  const pair = ends(raw);
  if (!pair) return null;
  const unit = HR_UNITS[unitOf(raw as DocTarget)];
  const value = unit === 'bpm' ? absolute(pair, 20, 255) : unit === 'percent' ? percent(pair, 100) : null;
  return value === null ? null : { key: 'target_heart_rate', value };
}

// A lower pace is a faster one, so the ends come back the other way round; a two-sided
// band is read either way, and this one is always two-sided.
function paceTarget(raw: unknown): Mapped | null {
  const pair = ends(raw);
  if (!pair) return null;
  const perKm = PACE_PER_KM[unitOf(raw as DocTarget)];
  if (!perKm) return null;

  const seconds = pair.map((value) => Math.round(perKm(value)));
  if (!seconds.every((value) => within(value, 60, 3600))) return null;
  return { key: 'target_pace_km', value: span(formatDuration(seconds[0]), formatDuration(seconds[1])) };
}

function cadenceTarget(raw: unknown): Mapped | null {
  const pair = ends(raw);
  if (!pair || !CADENCE_UNITS.has(unitOf(raw as DocTarget))) return null;
  const value = absolute(pair, 1, 254);
  return value === null ? null : { key: 'target_cadence', value };
}

/**
 * At most two, in the order `resolve.ts` ranks them: what you are told to run, then
 * what follows from it. FIT stores a primary and a secondary, so a third is dropped.
 */
function targetsOf(step: DocStep): Mapped[] {
  const mapped = [paceTarget(step.pace), powerTarget(step.power), hrTarget(step.hr), cadenceTarget(step.cadence)];
  return mapped.filter((target): target is Mapped => target !== null).slice(0, 2);
}

function intensityOf(step: DocStep): Intensity | null {
  if (step.warmup) return 'warmup';
  if (step.cooldown) return 'cooldown';
  if (step.recovery) return 'recovery';
  return null;
}

function planStep(entry: unknown): PlanStep | null {
  if (!isObject(entry)) return null;
  const step = entry as DocStep;

  const reps = number(step.reps);
  if (reps !== null && Array.isArray(step.steps)) {
    // Outside what a repeat may say, the group is dropped whole: a plan is not
    // improved by running its intervals a different number of times.
    if (!Number.isInteger(reps) || !within(reps, 1, 500)) return null;
    const steps = planSteps(step.steps);
    return steps.length > 0 ? { repeat: reps, steps } : null;
  }

  const effort: PlanEffort = {};
  const name = label(step.text);
  if (name) effort.name = name;

  const intensity = intensityOf(step);
  if (intensity) effort.intensity = intensity;

  // One duration each, theirs as ours: seconds, or metres where they measured it out.
  const seconds = number(step.duration);
  const metres = number(step.distance);
  if (seconds !== null) effort.goal_s = Math.round(seconds);
  else if (metres !== null) effort.goal_meters = Math.round(metres);

  for (const { key, value } of targetsOf(step)) (effort as Record<string, PlanValue>)[key] = value;
  return effort;
}

function planSteps(raw: unknown[]): PlanStep[] {
  return raw.map(planStep).filter((step): step is PlanStep => step !== null);
}

/** Their structured workout, as steps. Empty where there is no structure to read. */
export function stepsFromDoc(doc: unknown): PlanStep[] {
  if (!isObject(doc) || !Array.isArray(doc.steps)) return [];
  return planSteps(doc.steps);
}
