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
import type { Duration, HrValue, PowerValue, Sport, Step, Target, Workout } from './workout';

/**
 * Values written when one end of a range is left open. FIT has no "unbounded"
 * encoding, so we use limits no human will reach.
 */
const OPEN_ENDED = {
  speedLow: 0,
  speedHigh: 25, // m/s — ~90 km/h
  hrLow: 0,
  hrHigh: 255, // bpm
  powerLow: 0,
  powerHigh: 2000, // watts
  cadenceLow: 0,
  cadenceHigh: 254, // rpm
} as const;

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
    case 'calories':
      return { durationType: 'calories', durationValue: duration.calories };
    case 'reps':
      return { durationType: 'reps', durationValue: duration.reps };
    case 'hr_above':
      return { durationType: 'hrGreaterThan', durationValue: encodeHr(duration.hr) };
    case 'hr_below':
      return { durationType: 'hrLessThan', durationValue: encodeHr(duration.hr) };
    case 'power_above':
      return { durationType: 'powerGreaterThan', durationValue: encodePower(duration.power) };
    case 'power_below':
      return { durationType: 'powerLessThan', durationValue: encodePower(duration.power) };
  }
}

type TargetFields = {
  targetType: string;
  targetValue: number;
  customTargetValueLow?: number;
  customTargetValueHigh?: number;
};

/** FIT target type per zone metric. Pace zones are speed zones. */
const ZONE_TARGET_TYPE = { heart_rate: 'heartRate', pace: 'speed', power: 'power', cadence: 'cadence' } as const;

function encodeTarget(target: Target): TargetFields {
  switch (target.type) {
    case 'open':
      return { targetType: 'open', targetValue: 0 };
    case 'zone':
      return { targetType: ZONE_TARGET_TYPE[target.metric], targetValue: target.zone };
    case 'heart_rate':
      return {
        targetType: 'heartRate',
        targetValue: 0,
        customTargetValueLow: target.low ? encodeHr(target.low) : OPEN_ENDED.hrLow,
        customTargetValueHigh: target.high ? encodeHr(target.high) : encodeHr({ unit: 'bpm', value: OPEN_ENDED.hrHigh }),
      };
    case 'speed':
      return {
        targetType: 'speed',
        targetValue: 0,
        customTargetValueLow: encodeSpeed(target.low ?? OPEN_ENDED.speedLow),
        customTargetValueHigh: encodeSpeed(target.high ?? OPEN_ENDED.speedHigh),
      };
    case 'power':
      return {
        targetType: 'power',
        targetValue: 0,
        customTargetValueLow: target.low ? encodePower(target.low) : OPEN_ENDED.powerLow,
        customTargetValueHigh: target.high
          ? encodePower(target.high)
          : encodePower({ unit: 'watts', value: OPEN_ENDED.powerHigh }),
      };
    case 'cadence':
      return {
        targetType: 'cadence',
        targetValue: 0,
        customTargetValueLow: target.low ?? OPEN_ENDED.cadenceLow,
        customTargetValueHigh: target.high ?? OPEN_ENDED.cadenceHigh,
      };
  }
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
export function flattenSteps(steps: Step[], out: StepMesg[] = []): StepMesg[] {
  for (const step of steps) {
    if (step.kind === 'repeat') {
      const firstChildIndex = out.length;
      flattenSteps(step.steps, out);
      out.push({
        messageIndex: out.length,
        durationType: 'repeatUntilStepsCmplt',
        durationValue: firstChildIndex,
        // With durationType = repeatUntilStepsCmplt, targetValue holds the
        // repeat count (the profile's `repeatSteps` subfield).
        targetValue: step.times,
      });
      continue;
    }

    const mesg: StepMesg = {
      messageIndex: out.length,
      intensity: step.intensity,
      ...encodeDuration(step.duration),
      ...encodeTarget(step.target),
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

/** A stable non-zero serial number derived from the workout id (FIT uint32z). */
function serialFor(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  }
  return (hash >>> 0) || 1;
}

/** Encode a stored workout as a FIT workout file. */
export function encodeWorkoutFit(workout: Workout, now: Date = new Date()): Uint8Array {
  const steps = flattenSteps(workout.steps);
  const encoder = new Encoder();

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
  });

  for (const step of steps) {
    write(encoder, Profile.MesgNum.WORKOUT_STEP, step);
  }

  return encoder.close();
}

/** Download filename for a workout: `2026-09-12-a1b2c3d4.fit`. */
export const fitFilename = (workout: Pick<Workout, 'date' | 'id'>): string => `${workout.date}-${workout.id}.fit`;
