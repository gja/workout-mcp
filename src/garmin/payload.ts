/**
 * Turning one of our workouts into a Garmin Connect Training API workout.
 *
 * This is the counterpart of `src/fit.ts`: same source model, a different
 * destination. Both start from `resolveSteps`, which is what keeps the file
 * a watch imports and the session that lands in the Connect calendar
 * describing the same workout.
 *
 * Where the two differ is in what the destination can express, and this is
 * the lossy direction:
 *
 *   - FIT stores a flat list of steps with a repeat pointing back at its
 *     first child; the Training API nests the children inside the repeat.
 *   - FIT gives a step a name *and* a note; a Training API step has one
 *     `description`, so the name, the note and anything else that would
 *     otherwise be dropped are folded into it.
 *   - FIT stores a primary and a secondary target; the Training API stores
 *     one. The secondary is reported as dropped rather than silently lost.
 *   - FIT leaves an unbounded end of a range unset; the Training API wants
 *     both ends, so an open end becomes the metric's own extreme, which says
 *     the same thing without inventing a limit the athlete did not give.
 *
 * Every mapping table below is a plain record, deliberately: the Training API
 * is a partner API whose enum spellings are documented behind a login, and a
 * single wrong name fails the whole request. Keeping them as flat data means
 * correcting one is a one-line change here rather than a hunt through the
 * encoder — and `buildWorkout` is pure, so `sync_workouts` can hand back
 * exactly what it would have sent without sending it.
 */

import { describeTarget } from '../describe';
import { plannedTotals } from '../describe';
import { resolveSteps } from '../resolve';
import type { Duration, ResolvedStep, Target } from '../resolve';
import type { Intensity, Sport, SubSport, Workout } from '../workout';

/** Names this integration as the source of a workout, on Garmin's side. */
export const WORKOUT_PROVIDER = 'workout-mcp';

// ---------------------------------------------------------------------------
// The shapes we send
// ---------------------------------------------------------------------------

type TargetFields = {
  targetType: string;
  targetValue?: number;
  targetValueLow?: number;
  targetValueHigh?: number;
  /**
   * How to read the values, for the metrics that can be given either
   * absolutely or as a share of a reference the watch holds.
   */
  targetValueType?: string;
};

export type GarminExecutableStep = {
  type: 'WorkoutStep';
  stepOrder: number;
  intensity: string;
  description?: string;
  durationType: string;
  durationValue?: number;
} & TargetFields;

export type GarminRepeatStep = {
  type: 'WorkoutRepeatStep';
  stepOrder: number;
  repeatType: 'REPEAT_UNTIL_STEPS_CMPLT';
  repeatValue: number;
  steps: GarminStep[];
};

export type GarminStep = GarminExecutableStep | GarminRepeatStep;

export type GarminWorkout = {
  workoutName: string;
  description?: string;
  sport: string;
  subSport?: string;
  estimatedDurationInSecs?: number;
  estimatedDistanceInMeters?: number;
  workoutProvider: string;
  /** Our own id for the workout, so Garmin can tell where a session came from. */
  workoutSourceId: string;
  isSessionTransitionEnabled: boolean;
  segments: Array<{ segmentOrder: number; sport: string; steps: GarminStep[] }>;
};

/**
 * A built payload, plus what building it cost.
 *
 * `notes` is not decoration: it is the record of everything the Training API
 * could not carry. A sync reports it, so an athlete whose secondary cadence
 * target did not make it onto the watch finds that out from the sync rather
 * than from a session that felt wrong.
 */
export type BuiltWorkout = { workout: GarminWorkout; notes: string[] };

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

const GARMIN_SPORT: Record<Sport, string> = {
  running: 'RUNNING',
  cycling: 'CYCLING',
  swimming: 'LAP_SWIMMING',
  walking: 'WALKING',
  hiking: 'HIKING',
  rowing: 'ROWING',
  // Our `training` is FIT's: a gym session driven by time and heart rate
  // rather than by distance, which is what Garmin calls cardio training.
  training: 'CARDIO_TRAINING',
  generic: 'OTHER',
};

/**
 * Sub-sports, where a Garmin equivalent is unambiguous.
 *
 * Partial on purpose. A sub-sport is a hint the watch uses to pick an
 * activity profile, so getting one wrong is a small loss — but sending an
 * enum name Garmin does not know fails the entire workout, which is a large
 * one. Anything not listed is simply left off the payload.
 */
const GARMIN_SUB_SPORT: Partial<Record<SubSport, string>> = {
  treadmill: 'TREADMILL',
  street: 'STREET',
  trail: 'TRAIL',
  track: 'TRACK',
  road: 'ROAD',
  mountain: 'MOUNTAIN',
  indoor_cycling: 'INDOOR_CYCLING',
  spin: 'SPIN',
  virtual_activity: 'VIRTUAL_ACTIVITY',
  lap_swimming: 'LAP_SWIMMING',
  open_water: 'OPEN_WATER',
  indoor_rowing: 'INDOOR_ROWING',
  indoor_walking: 'INDOOR_WALKING',
};

const GARMIN_INTENSITY: Record<Intensity, string> = {
  warmup: 'WARMUP',
  active: 'ACTIVE',
  interval: 'INTERVAL',
  rest: 'REST',
  recovery: 'RECOVERY',
  cooldown: 'COOLDOWN',
};

/** Zone targets, which the watch resolves against its own configuration. */
const GARMIN_ZONE_TARGET = {
  heart_rate: 'HEART_RATE_ZONE',
  power: 'POWER_ZONE',
  pace: 'PACE_ZONE',
} as const;

/**
 * What stands in for an end of a range the athlete left open.
 *
 * These are the extremes our own parsers already accept — 20-255 bpm,
 * 1-2000 W, 1-254 rpm — so "above 140 bpm" becomes 140-255 rather than
 * 140 and a bound out of thin air. Speed has no such natural limit, so it
 * gets a pair either side of anything a human does on foot or a bike.
 */
const OPEN_ENDS = {
  heartRate: { low: 20, high: 255 },
  power: { low: 1, high: 2000 },
  cadence: { low: 1, high: 254 },
  /** Metres per second: a slow walk, and faster than a track sprint. */
  speed: { low: 0.1, high: 25 },
  /**
   * Percentages have a ceiling per metric, not one shared ceiling. A share of
   * max heart rate cannot exceed 100, but 150% of FTP is an ordinary VO2max
   * interval — which is why `parsePower` accepts percentages up to 1000 where
   * `parseHr` stops at 100. Sharing a ceiling of 100 between them turned
   * `target_watts: ["110%", "-"]` into a band from 110 to 100: inverted, and
   * past the point where `assertOrdered` could have caught it, since that only
   * fires when the caller gave both ends.
   */
  percentHeartRate: { low: 1, high: 100 },
  percentPower: { low: 1, high: 1000 },
};

// ---------------------------------------------------------------------------
// Durations and targets
// ---------------------------------------------------------------------------

function garminDuration(duration: Duration): { durationType: string; durationValue?: number } {
  switch (duration.type) {
    case 'open':
      return { durationType: 'OPEN' };
    case 'time':
      return { durationType: 'TIME', durationValue: Math.round(duration.seconds) };
    case 'distance':
      return { durationType: 'DISTANCE', durationValue: Math.round(duration.meters) };
  }
}

/** Round to three places: speeds are in m/s, where the third place matters. */
const round = (value: number): number => Math.round(value * 1000) / 1000;

function garminTarget(target: Target): TargetFields {
  switch (target.type) {
    case 'open':
      return { targetType: 'OPEN' };

    case 'zone':
      return { targetType: GARMIN_ZONE_TARGET[target.metric], targetValue: target.zone };

    case 'heart_rate': {
      // `parseRange` has already refused a range that mixes the two units, so
      // either end tells us how to read both.
      const percent = (target.low ?? target.high)?.unit === 'percent';
      const ends = percent ? OPEN_ENDS.percentHeartRate : OPEN_ENDS.heartRate;
      return {
        targetType: 'HEART_RATE',
        targetValueLow: target.low?.value ?? ends.low,
        targetValueHigh: target.high?.value ?? ends.high,
        ...(percent ? { targetValueType: 'PERCENT_MAX_HEART_RATE' } : {}),
      };
    }

    case 'power': {
      const percent = (target.low ?? target.high)?.unit === 'percent';
      const ends = percent ? OPEN_ENDS.percentPower : OPEN_ENDS.power;
      return {
        targetType: 'POWER',
        targetValueLow: target.low?.value ?? ends.low,
        targetValueHigh: target.high?.value ?? ends.high,
        ...(percent ? { targetValueType: 'PERCENT_FTP' } : {}),
      };
    }

    case 'cadence':
      return {
        targetType: 'CADENCE',
        targetValueLow: target.low ?? OPEN_ENDS.cadence.low,
        targetValueHigh: target.high ?? OPEN_ENDS.cadence.high,
      };

    case 'speed':
      // Speeds stay in metres per second, which is the unit FIT and the
      // Training API both use; whether the athlete wrote the pace per km or
      // per mile is a presentation detail that does not survive the trip.
      return {
        targetType: 'PACE',
        targetValueLow: round(target.low ?? OPEN_ENDS.speed.low),
        targetValueHigh: round(target.high ?? OPEN_ENDS.speed.high),
      };
  }
}

/** Whether a target left an end open, so the fill can be reported. */
const isOpenEnded = (target: Target): boolean =>
  (target.type === 'heart_rate' || target.type === 'power' || target.type === 'cadence' || target.type === 'speed') &&
  (target.low === null || target.high === null);

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * A step's `description`: its name, its note, and anything the payload could
 * not carry, in that order.
 *
 * The name leads because it is what the athlete gave the step and what they
 * will look for on the watch.
 */
function stepDescription(step: Extract<ResolvedStep, { kind: 'step' }>, extra: string[]): string | undefined {
  const parts = [step.name, step.notes, ...extra].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return undefined;
  // Garmin caps a step description well above this; the cap here is so a
  // pathological note cannot make the whole workout unreadable on a watch.
  return parts.join(' — ').slice(0, 512);
}

/**
 * Walk the resolved tree into Garmin's nested form.
 *
 * `stepOrder` is one counter across the whole workout, repeats included, and
 * a repeat takes its number before its children — which is the order they
 * read in, and the order Garmin's own workouts come back in.
 */
function garminSteps(steps: ResolvedStep[], state: { order: number; notes: string[] }): GarminStep[] {
  return steps.map((step) => {
    if (step.kind === 'repeat') {
      const stepOrder = state.order++;
      return {
        type: 'WorkoutRepeatStep',
        stepOrder,
        repeatType: 'REPEAT_UNTIL_STEPS_CMPLT',
        repeatValue: step.times,
        steps: garminSteps(step.steps, state),
      } satisfies GarminRepeatStep;
    }

    const stepOrder = state.order++;
    const label = step.name ?? `step ${stepOrder}`;
    const extra: string[] = [];

    if (step.secondary_target) {
      // One target per step on Garmin's side, so the second one becomes prose
      // the athlete can still read rather than nothing at all.
      const described = describeTarget(step.secondary_target);
      if (described) {
        extra.push(`also ${described}`);
        state.notes.push(`"${label}": Garmin holds one target per step, so ${described} moved into the description`);
      }
    }
    if (isOpenEnded(step.target)) {
      const described = describeTarget(step.target);
      state.notes.push(
        `"${label}": Garmin needs both ends of a target range, so ${described ?? 'the target'} was widened to the metric's limit`,
      );
    }

    const description = stepDescription(step, extra);
    return {
      type: 'WorkoutStep',
      stepOrder,
      intensity: GARMIN_INTENSITY[step.intensity],
      ...(description ? { description } : {}),
      ...garminDuration(step.duration),
      ...garminTarget(step.target),
    } satisfies GarminExecutableStep;
  });
}

// ---------------------------------------------------------------------------
// The workout
// ---------------------------------------------------------------------------

/**
 * A Garmin Training API workout, and the notes on what did not fit.
 *
 * Pure: no clock, no network, nothing from the connection. That is what lets
 * a dry-run sync show the athlete exactly what would be sent, and what lets
 * the fingerprint that decides whether to push at all be taken over the
 * result.
 */
export function buildWorkout(workout: Workout): BuiltWorkout {
  const notes: string[] = [];
  const state = { order: 1, notes };
  const sport = GARMIN_SPORT[workout.sport];
  const steps = garminSteps(resolveSteps(workout.steps), state);
  const totals = plannedTotals(workout.steps);

  const subSport = workout.sub_sport ? GARMIN_SUB_SPORT[workout.sub_sport] : undefined;
  if (workout.sub_sport && !subSport) {
    notes.push(`Garmin has no equivalent for the "${workout.sub_sport}" sub-sport, so it was left off`);
  }

  const built: GarminWorkout = {
    workoutName: workout.name.slice(0, 80),
    ...(workout.notes ? { description: workout.notes.slice(0, 1024) } : {}),
    sport,
    ...(subSport ? { subSport } : {}),
    // Only sent when the plan actually adds up to something: a session of
    // open-ended steps has no duration to estimate, and a zero would read as
    // a claim rather than as an absence.
    ...(totals.seconds > 0 ? { estimatedDurationInSecs: Math.round(totals.seconds) } : {}),
    ...(totals.meters > 0 ? { estimatedDistanceInMeters: totals.meters } : {}),
    workoutProvider: WORKOUT_PROVIDER,
    workoutSourceId: workout.id,
    isSessionTransitionEnabled: false,
    segments: [{ segmentOrder: 1, sport, steps }],
  };

  return { workout: built, notes };
}
