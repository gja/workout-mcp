// FIT workout encoding, via the Garmin SDK. Read docs/fit.md before changing any of it.

import { Encoder, Profile } from '@garmin/fitsdk';
import { resolveSteps } from './resolve';
import type { Duration, HrValue, PowerValue, ResolvedStep, Target } from './resolve';
import type { Sport, SubSport, Workout } from './workout';

/** The encoder's scratch buffer ceiling. A workout file is a few hundred bytes. */
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
 * What is written for the end of a range the caller left open. FIT has no value
 * that reads as "no limit", and no shape for half a band either: intervals.icu
 * rejects a step carrying only one of the two bounds — "Missing
 * custom_target_value_low and/or custom_target_value_high" — and drops it from
 * the workout. So both ends are always written, and the open one gets a limit
 * no athlete reaches.
 *
 * Heart rate and power pack two units into one field, so the filler goes in
 * whatever unit the caller used for the end they did give — a raw 0 under a
 * ceiling in watts is 0% of FTP under 120 W, two units in one band. Neither is
 * ever the offset itself (100 for heart rate, 1000 for power): that is the one
 * value where the two units meet — the SDK's own decoder reads a 100 back as
 * `bpmOffset` rather than as 100% — so a percentage ceiling stops just under it.
 */
const OPEN_ENDED = {
  hr: { bpm: { low: 1, high: 255 }, percent: { low: 1, high: 99 } },
  power: { watts: { low: 1, high: 2000 }, percent: { low: 1, high: 999 } },
  // Speed and cadence carry one unit each, so their plain extremes are unambiguous.
  speed: { low: 0, high: 25 }, // m/s, ~90 km/h
  cadence: { low: 0, high: 254 },
} as const;

/** `low`/`high` are absent only where the target is not a custom range at all. */
type TargetFields = { type: string; value: number; low?: number; high?: number };

/** FIT target type per zone metric. Pace zones are speed zones. */
const ZONE_TARGET_TYPE = { heart_rate: 'heartRate', pace: 'speed', power: 'power' } as const;

function encodeTarget(target: Target): TargetFields {
  switch (target.type) {
    case 'open':
      return { type: 'open', value: 0 };
    case 'zone':
      return { type: ZONE_TARGET_TYPE[target.metric], value: target.zone };
    case 'heart_rate': {
      // One end is always given, and both share a field, so both take its unit.
      const unit = (target.low ?? target.high)?.unit ?? 'bpm';
      const open = OPEN_ENDED.hr[unit];
      return {
        type: 'heartRate',
        value: 0,
        low: encodeHr(target.low ?? { unit, value: open.low }),
        high: encodeHr(target.high ?? { unit, value: open.high }),
      };
    }
    case 'speed':
      return {
        type: 'speed',
        value: 0,
        low: encodeSpeed(target.low ?? OPEN_ENDED.speed.low),
        high: encodeSpeed(target.high ?? OPEN_ENDED.speed.high),
      };
    case 'power': {
      const unit = (target.low ?? target.high)?.unit ?? 'watts';
      const open = OPEN_ENDED.power[unit];
      return {
        type: 'power',
        value: 0,
        low: encodePower(target.low ?? { unit, value: open.low }),
        high: encodePower(target.high ?? { unit, value: open.high }),
      };
    }
    case 'cadence':
      return {
        type: 'cadence',
        value: 0,
        low: target.low ?? OPEN_ENDED.cadence.low,
        high: target.high ?? OPEN_ENDED.cadence.high,
      };
  }
}

/** The same fields under the primary or the secondary names. */
function targetMesgFields(target: Target, secondary: boolean): Record<string, unknown> {
  const { type, value, low, high } = encodeTarget(target);
  const fields: Record<string, unknown> = secondary
    ? { secondaryTargetType: type, secondaryTargetValue: value }
    : { targetType: type, targetValue: value };

  // A zone or an open target has no range at all; a custom range always has both ends.
  if (low !== undefined) fields[secondary ? 'secondaryCustomTargetValueLow' : 'customTargetValueLow'] = low;
  if (high !== undefined) fields[secondary ? 'secondaryCustomTargetValueHigh' : 'customTargetValueHigh'] = high;
  return fields;
}

/** One encoded FIT workout step, before message indices are assigned. */
type StepMesg = Record<string, unknown>;

/** The SDK types enums as `number`, but the encoder resolves the profile's names too. */
type FitEncoder = { onMesg(mesgNum: number, mesg: Record<string, unknown>): void };

const write = (encoder: Encoder, mesgNum: number, mesg: Record<string, unknown>): void =>
  (encoder as unknown as FitEncoder).onMesg(mesgNum, mesg);

/** A repeat points back at its first child, so children are emitted before it. */
export function flattenSteps(steps: ResolvedStep[], out: StepMesg[] = []): StepMesg[] {
  for (const step of steps) {
    if (step.kind === 'repeat') {
      const firstChildIndex = out.length;
      flattenSteps(step.steps, out);
      out.push({
        messageIndex: out.length,
        durationType: 'repeatUntilStepsCmplt',
        durationValue: firstChildIndex,
        // Written even though a repeat has no target: importers choke on the record missing it.
        targetType: 'open',
        // Under repeatUntilStepsCmplt this is the `repeatSteps` subfield, not a target.
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

/** FIT uint32z, so it must be non-zero. */
function serialFor(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  }
  return (hash >>> 0) || 1;
}

// The SDK asks for a 500 MB resizable buffer, which production workerd refuses; see docs/fit.md.
// The swap is safe: one synchronous constructor call, so no other request can run inside it.
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
    ...(workout.notes ? { wktDescription: workout.notes } : {}),
  });

  for (const step of steps) {
    write(encoder, Profile.MesgNum.WORKOUT_STEP, step);
  }

  return encoder.close();
}

/** For callers with no file to hand back: the MCP tool, and the platform adapters. */
export function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Download filename for a workout: `2026-09-12-a1b2c3d4.fit`. Mirrors the export URL. */
export const fitFilename = (workout: Pick<Workout, 'date' | 'id'>): string => `${workout.date}-${workout.id}.fit`;

/** `2026-09-12-4x10-Tempo.fit`, for a caller given the bytes rather than the URL. */
export function fitDownloadName(workout: Pick<Workout, 'date' | 'id' | 'name'>): string {
  const slug = (workout.name ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return `${workout.date}-${slug || workout.id}.fit`;
}
