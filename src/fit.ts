/**
 * FIT workout file encoding, via the Garmin FIT JavaScript SDK.
 *
 * Two details drive most of this file:
 *
 *  - The SDK's encoder writes *parent* fields only; it does not resolve
 *    subfield names like `durationTime` or `customTargetSpeedLow`. So we write
 *    `durationValue` / `customTargetValueLow` / `customTargetValueHigh`
 *    ourselves and apply the profile's scaling (time x1000, distance x100,
 *    speed x1000).
 *  - Nested repeats are flattened. FIT stores a flat list of steps; a repeat is
 *    a step emitted *after* its children whose duration value points back at
 *    the message index of the first child.
 */

import { Encoder, Profile } from '@garmin/fitsdk';
import { resolveSteps } from './resolve';
import type { Duration, HrValue, PowerValue, ResolvedStep, Target } from './resolve';
import type { Sport, SubSport, Workout } from './workout';

/**
 * The most the encoder's scratch buffer may reserve. A workout file is a few
 * hundred bytes; a megabyte is already far more than any plan will need.
 */
const MAX_FIT_BYTES = 1024 * 1024;

/** `workoutHr`: 0-100 is a percentage of max HR, above 100 is bpm + 100. */
const encodeHr = (hr: HrValue): number => (hr.unit === 'percent' ? hr.value : hr.value + 100);

/** `workoutPower`: 0-1000 is a percentage of FTP, above 1000 is watts + 1000. */
const encodePower = (power: PowerValue): number => (power.unit === 'percent' ? power.value : power.value + 1000);

const encodeSpeed = (metresPerSecond: number): number => Math.round(metresPerSecond * 1000);

type DurationFields = { durationType: string; durationValue?: number };

function encodeDuration(duration: Duration): DurationFields {
  switch (duration.type) {
    case 'open':
      return { durationType: 'open' };
    case 'time':
      return { durationType: 'time', durationValue: Math.round(duration.seconds * 1000) };
    case 'distance':
      return { durationType: 'distance', durationValue: Math.round(duration.meters * 100) };
  }
}

/**
 * A target in FIT's shape, before it is named primary or secondary.
 *
 * `low` and `high` are absent when that end of the range was left open. An
 * absent field means "not set", which is what an open end is; writing a
 * stand-in value instead invents a bound the athlete never asked for, and
 * FIT has no value that reads as "no limit" — a 0 floor on a power range is
 * read as 0% of FTP, not as "no floor".
 */
type TargetFields = { type: string; value: number; low?: number; high?: number };

/** FIT target type per zone metric. Pace zones are speed zones. */
const ZONE_TARGET_TYPE = { heart_rate: 'heartRate', pace: 'speed', power: 'power' } as const;

function encodeTarget(target: Target): TargetFields {
  switch (target.type) {
    case 'open':
      return { type: 'open', value: 0 };
    case 'zone':
      return { type: ZONE_TARGET_TYPE[target.metric], value: target.zone };
    case 'heart_rate':
      return {
        type: 'heartRate',
        value: 0,
        ...(target.low ? { low: encodeHr(target.low) } : {}),
        ...(target.high ? { high: encodeHr(target.high) } : {}),
      };
    case 'speed':
      return {
        type: 'speed',
        value: 0,
        ...(target.low === null ? {} : { low: encodeSpeed(target.low) }),
        ...(target.high === null ? {} : { high: encodeSpeed(target.high) }),
      };
    case 'power':
      return {
        type: 'power',
        value: 0,
        ...(target.low ? { low: encodePower(target.low) } : {}),
        ...(target.high ? { high: encodePower(target.high) } : {}),
      };
    case 'cadence':
      return {
        type: 'cadence',
        value: 0,
        ...(target.low === null ? {} : { low: target.low }),
        ...(target.high === null ? {} : { high: target.high }),
      };
  }
}

/** The same fields under the primary or the secondary names. */
function targetMesgFields(target: Target, secondary: boolean): Record<string, unknown> {
  const { type, value, low, high } = encodeTarget(target);
  const fields: Record<string, unknown> = secondary
    ? { secondaryTargetType: type, secondaryTargetValue: value }
    : { targetType: type, targetValue: value };

  // Each bound is written only if it exists, so an open end leaves the field
  // out of the step's definition entirely.
  if (low !== undefined) fields[secondary ? 'secondaryCustomTargetValueLow' : 'customTargetValueLow'] = low;
  if (high !== undefined) fields[secondary ? 'secondaryCustomTargetValueHigh' : 'customTargetValueHigh'] = high;
  return fields;
}

/** One encoded FIT workout step, before message indices are assigned. */
type StepMesg = Record<string, unknown>;

/**
 * The SDK types every enum field as `number`, but the encoder also accepts the
 * profile's string names (`'time'`, `'heartRate'`, ...) and resolves them. We
 * use the names for readability and narrow the encoder's type here, once.
 */
type FitEncoder = { onMesg(mesgNum: number, mesg: Record<string, unknown>): void };

const write = (encoder: Encoder, mesgNum: number, mesg: Record<string, unknown>): void =>
  (encoder as unknown as FitEncoder).onMesg(mesgNum, mesg);

/**
 * Flatten the step tree into FIT's linear form.
 *
 * A repeat becomes a trailing step pointing back at its first child, which is
 * why children are emitted first and the repeat is pushed afterwards.
 */
export function flattenSteps(steps: ResolvedStep[], out: StepMesg[] = []): StepMesg[] {
  for (const step of steps) {
    if (step.kind === 'repeat') {
      const firstChildIndex = out.length;
      flattenSteps(step.steps, out);
      out.push({
        messageIndex: out.length,
        durationType: 'repeatUntilStepsCmplt',
        durationValue: firstChildIndex,
        // A repeat has no target of its own, but the field is written anyway:
        // Garmin's own exports carry it, and an importer that reads
        // targetType on every step chokes on the one record missing it.
        targetType: 'open',
        // With durationType = repeatUntilStepsCmplt, targetValue holds the
        // repeat count (the profile's `repeatSteps` subfield), which resolves
        // off durationType and so is unaffected by targetType above.
        targetValue: step.times,
      });
      continue;
    }

    const mesg: StepMesg = {
      messageIndex: out.length,
      intensity: step.intensity,
      ...encodeDuration(step.duration),
      ...targetMesgFields(step.target, false),
      ...(step.secondary_target ? targetMesgFields(step.secondary_target, true) : {}),
    };
    if (step.name) mesg.wktStepName = step.name;
    if (step.notes) mesg.notes = step.notes;
    out.push(mesg);
  }
  return out;
}

const FIT_SPORT: Record<Sport, string> = {
  running: 'running',
  cycling: 'cycling',
  swimming: 'swimming',
  walking: 'walking',
  hiking: 'hiking',
  rowing: 'rowing',
  training: 'training',
  generic: 'generic',
};

/** Our sub-sport names to the FIT enum's. */
const FIT_SUB_SPORT: Record<SubSport, string> = {
  treadmill: 'treadmill',
  street: 'street',
  trail: 'trail',
  track: 'track',
  ultra: 'ultra',
  road: 'road',
  mountain: 'mountain',
  indoor_cycling: 'indoorCycling',
  spin: 'spin',
  virtual_activity: 'virtualActivity',
  lap_swimming: 'lapSwimming',
  open_water: 'openWater',
  indoor_rowing: 'indoorRowing',
  indoor_walking: 'indoorWalking',
  generic: 'generic',
};

/** A stable non-zero serial number derived from the workout id (FIT uint32z). */
function serialFor(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  }
  return (hash >>> 0) || 1;
}

/**
 * Build an encoder whose scratch buffer fits inside a Worker.
 *
 * The SDK's `OutputStream` asks for a *resizable* ArrayBuffer with a 500 MB
 * `maxByteLength`. V8 reserves that much address space up front, which
 * production workerd refuses against the isolate's memory cap — so the
 * encoder threw before writing a byte, while dev workerd let it through. The
 * size is a private field with no constructor option, so the allocation is
 * clamped here instead.
 *
 * The swap spans a single synchronous constructor call with no `await` in it,
 * so no other request can run while the global is replaced.
 */
function createEncoder(): Encoder {
  const NativeArrayBuffer = globalThis.ArrayBuffer;

  class ClampedArrayBuffer extends NativeArrayBuffer {
    constructor(length: number, options?: { maxByteLength?: number }) {
      if (options?.maxByteLength === undefined) {
        super(length);
        return;
      }
      super(length, { maxByteLength: Math.max(length, Math.min(options.maxByteLength, MAX_FIT_BYTES)) });
    }
  }

  globalThis.ArrayBuffer = ClampedArrayBuffer as unknown as ArrayBufferConstructor;
  try {
    return new Encoder();
  } finally {
    globalThis.ArrayBuffer = NativeArrayBuffer;
  }
}

export function encodeWorkoutFit(workout: Workout, now: Date = new Date()): Uint8Array {
  const steps = flattenSteps(resolveSteps(workout.steps));
  const encoder = createEncoder();

  write(encoder, Profile.MesgNum.FILE_ID, {
    type: 'workout',
    manufacturer: 'development',
    product: 0,
    serialNumber: serialFor(workout.id),
    timeCreated: now,
  });

  write(encoder, Profile.MesgNum.WORKOUT, {
    wktName: workout.name,
    sport: FIT_SPORT[workout.sport],
    numValidSteps: steps.length,
    ...(workout.sub_sport ? { subSport: FIT_SUB_SPORT[workout.sub_sport] } : {}),
    // The session description the athlete wrote, which the watch shows.
    ...(workout.notes ? { wktDescription: workout.notes } : {}),
  });

  for (const step of steps) {
    write(encoder, Profile.MesgNum.WORKOUT_STEP, step);
  }

  return encoder.close();
}

/** Download filename for a workout: `2026-09-12-a1b2c3d4.fit`. Mirrors the export URL. */
export const fitFilename = (workout: Pick<Workout, 'date' | 'id'>): string => `${workout.date}-${workout.id}.fit`;

/**
 * The name to save an exported workout under: `2026-09-12-4x10-Tempo.fit`.
 *
 * A caller that gets the bytes rather than the URL — every MCP client — has no
 * filename to fall back on, and a folder of these should read as a plan rather
 * than a list of ids. Anything a filesystem would argue about collapses to a
 * dash, and a workout whose name survives none of that keeps its id.
 */
export function fitDownloadName(workout: Pick<Workout, 'date' | 'id' | 'name'>): string {
  const slug = (workout.name ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return `${workout.date}-${slug || workout.id}.fit`;
}
