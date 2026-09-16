// Stats read once off a recorded FIT file, so a review never downloads it again.
// What is kept, what is deliberately not, and how laps are matched: docs/stats.md.

import { Decoder, Stream } from '@garmin/fitsdk';
import type { SessionMesg } from '@garmin/fitsdk';
import { resolveSteps } from './resolve';
import type { Duration, ResolvedStep, Target } from './resolve';
import type { Intensity, Workout } from './workout';

/** A recording larger than this is refused unread: decoding it would outrun the Worker. */
export const MAX_RECORDING_BYTES = 8 * 1024 * 1024;

/** The shortest gap between records that can be a pause rather than a slow sample. */
const PAUSE_GAP_S = 10;

/** How many times the usual gap a real stop is. Smart recording samples irregularly. */
const PAUSE_MULTIPLE = 4;

/** A stop this long is worth telling the reader about. */
const LONG_PAUSE_S = 120;

/**
 * How far a barometric altitude has to move before it counts as climbing.
 *
 * Summing every rise in an unsmoothed trace turns sensor drift into hundreds of metres,
 * so a rise is only taken once it clears the noise, and from wherever it was last taken
 * from. Three metres is what the platforms that do this settle on.
 */
const ELEVATION_NOISE_M = 3;

/** The window a normalized-power average rolls over, as Coggan defined it. */
const NORMALIZED_WINDOW_S = 30;

/** Laps a watch may have collected before the session proper started. */
const FALSE_STARTS = 2;

/** Below this, quartering a lap measures noise rather than execution. */
const SHORT_LAP_S = 60;

/** Slower than this is standing still, whatever the sensor says. */
const MIN_SPEED_MS = 0.2;

/** Sports whose FIT cadence is one leg, and whose athletes count both. */
const TWO_STEPS_PER_CYCLE = new Set(['running', 'walking', 'hiking']);

export type Role = 'warmup' | 'work' | 'recovery' | 'cooldown' | 'unclassified';

/** What a target and a quarters array are measured in. Pace is seconds per km, so lower is faster. */
export type Metric = 'hr' | 'pace_s_km' | 'power_w' | 'cadence';

/** Four equal segments of a lap. An entry is null where the quarter recorded nothing. */
export type Quarters = {
  split_by: 'time' | 'distance';
  /** What the ground did in each quarter: the end of it minus the start, and how steep. */
  elev_net_m: Array<number | null> | null;
  grade_pct: Array<number | null> | null;
} & Record<Metric, Array<number | null> | null>;

/** The planned band this lap was run against, and how much of the lap sat inside it. */
export type LapTarget = {
  metric: Metric;
  low: number;
  high: number;
  pct_time_in_band: number;
  pct_time_above: number;
  pct_time_below: number;
};

export type LapStats = {
  index: number;
  /** What ended the lap: `manual`, `time`, `distance`, `positionStart`… as FIT names it. */
  trigger: string | null;
  role: Role;
  /** Which time round a repeat block this lap is, or null outside one. */
  rep_number: number | null;
  planned_step_index: number | null;
  planned_step_name: string | null;
  match_confidence: 'high' | 'low' | 'unmatched';
  duration_s: number | null;
  moving_s: number | null;
  distance_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  /** How far heart rate fell. The signal a recovery lap is there to produce, and invisible in an average. */
  min_hr: number | null;
  avg_pace_s_km: number | null;
  avg_cadence: number | null;
  avg_power_w: number | null;
  max_power_w: number | null;
  normalized_power_w: number | null;
  elev_gain_m: number | null;
  elev_loss_m: number | null;
  /** Where the lap finished against where it started, and the average grade between. */
  elev_net_m: number | null;
  avg_grade_pct: number | null;
  quarters: Quarters | null;
  target: LapTarget | null;
  flags: string[];
};

export type SessionStats = {
  sport: string | null;
  sub_sport: string | null;
  /** No position was recorded, so pace, distance and elevation are the sensor's word alone. */
  indoor: boolean;
  start_time: string | null;
  elapsed_s: number | null;
  moving_s: number | null;
  timer_s: number | null;
  distance_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  min_hr: number | null;
  avg_pace_s_km: number | null;
  avg_cadence: number | null;
  avg_power_w: number | null;
  max_power_w: number | null;
  normalized_power_w: number | null;
  work_kj: number | null;
  /** Normalized over average power: how evenly the session was ridden. */
  variability_index: number | null;
  total_ascent_m: number | null;
  total_descent_m: number | null;
  calories: number | null;
};

/** What is stored against a workout once the platform has the recording. */
export type WorkoutStats = {
  platform: string;
  activity_id: string;
  computed_at: string;
  session: SessionStats | null;
  laps: LapStats[];
  flags: string[];
  /** Why there is nothing else here. Only ever set beside a `source_unreadable` flag. */
  error?: string;
  /** How many times reading it has been tried, so a transient failure is not forever. */
  attempts?: number;
};

/** A workout carries the totals; the laps are their own read. See `sessionOnly`. */
export type StatsSummary = Omit<WorkoutStats, 'laps'>;

export type Source = { platform: string; activity_id: string };

// --- Reading the file --------------------------------------------------------

const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Heart rate, cadence and an average power of zero all mean "not recorded", never zero. */
const positive = (value: unknown): number | null => {
  const parsed = number(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};

const round = (value: number | null, places = 0): number | null => {
  if (value === null) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** Milliseconds, as the decoder hands timestamps back — it converts them to dates by default. */
const at = (value: unknown): number | null => (value instanceof Date ? value.getTime() : null);

const iso = (value: unknown): string | null => {
  const milliseconds = at(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
};

/**
 * What counts as a pause in this recording, rather than in the abstract.
 *
 * A watch on smart recording writes a sample every ten or fifteen seconds, and calling
 * each of those gaps a stop leaves every lap with no moving time at all and no quarters
 * to show for it. So the device's own cadence sets the bar, with a floor under it.
 */
function pauseGapOf(gaps: number[]): number {
  if (gaps.length === 0) return PAUSE_GAP_S;
  const sorted = [...gaps].sort((left, right) => left - right);
  return Math.max(PAUSE_GAP_S, sorted[Math.floor(sorted.length / 2)] * PAUSE_MULTIPLE);
}

const paceOf = (metresPerSecond: number | null): number | null =>
  metresPerSecond !== null && metresPerSecond >= MIN_SPEED_MS ? Math.round(1000 / metresPerSecond) : null;

/** FIT counts one leg per cycle; an athlete counts both, and a cyclist counts the crank once. */
const cadenceOf = (value: number | null, sport: string | null): number | null =>
  value === null ? null : sport !== null && TWO_STEPS_PER_CYCLE.has(sport) ? value * 2 : value;

export class StatsError extends Error {}

/** One sample, reduced to what any of the figures below need. */
type Sample = {
  time: number;
  /** Moving seconds this sample stands for: the gap back to the last one, pauses dropped. */
  moving: number;
  /** And the metres, for a lap quartered by distance rather than by time. */
  metres: number;
  altitude: number | null;
  hr: number | null;
  pace_s_km: number | null;
  power_w: number | null;
  cadence: number | null;
};

// --- Laps against the plan ---------------------------------------------------

/** A planned step as the recording should have run it, repeats expanded in order. */
type PlannedStep = {
  index: number;
  name: string | null;
  rep_number: number | null;
  duration: Duration;
  target: Target;
  intensity: Intensity;
};

function flattenPlan(workout: Workout): PlannedStep[] {
  const flat: PlannedStep[] = [];

  const walk = (steps: ResolvedStep[], repNumber: number | null): void => {
    for (const step of steps) {
      if (step.kind === 'repeat') {
        for (let rep = 1; rep <= step.times; rep += 1) walk(step.steps, rep);
        continue;
      }
      flat.push({
        index: flat.length,
        name: step.name ?? null,
        rep_number: repNumber,
        duration: step.duration,
        target: step.target,
        intensity: step.intensity,
      });
    }
  };

  // A plan we cannot resolve is one nothing can be mapped against, which is not a reason
  // to lose the numbers: the laps come back unmatched instead.
  try {
    walk(resolveSteps(workout.steps), null);
  } catch {
    return [];
  }
  return flat;
}

const ROLE_BY_INTENSITY: Record<string, Role> = {
  warmup: 'warmup',
  cooldown: 'cooldown',
  rest: 'recovery',
  recovery: 'recovery',
  active: 'work',
  interval: 'work',
};

/**
 * How far a lap may be off its step's length, asked twice for two different reasons.
 *
 * Whether to map at all is decided on the tight bar: a lap press missed halfway through
 * throws every later lap against the wrong step, and only a strict reading catches that.
 * Whether a mapping made is a *good* one is reported on the loose one, because `low` is
 * for genuine ambiguity — a cooldown run 844 m of a planned kilometre is the ordinary
 * shape of a session ending, and a field that fires on that gets ignored.
 */
const TOLERANCE = {
  mapping: { share_s: 0.25, floor_s: 20, share_m: 0.1, floor_m: 50 },
  confidence: { share_s: 0.5, floor_s: 20, share_m: 0.5, floor_m: 50 },
} as const;

type Tolerance = (typeof TOLERANCE)[keyof typeof TOLERANCE];

const within = (planned: PlannedStep, lap: LapStats, tolerance: Tolerance): boolean => {
  switch (planned.duration.type) {
    case 'open':
      return true;
    case 'time': {
      const actual = lap.moving_s ?? lap.duration_s;
      const allowed = Math.max(tolerance.floor_s, planned.duration.seconds * tolerance.share_s);
      return actual !== null && Math.abs(actual - planned.duration.seconds) <= allowed;
    }
    case 'distance': {
      const allowed = Math.max(tolerance.floor_m, planned.duration.meters * tolerance.share_m);
      return lap.distance_m !== null && Math.abs(lap.distance_m - planned.duration.meters) <= allowed;
    }
  }
};

/** Close enough to be the step it was meant to be, with room for a late lap press. */
const matches = (planned: PlannedStep, lap: LapStats): boolean => within(planned, lap, TOLERANCE.mapping);

/**
 * Which planned step each lap was, or nothing at all.
 *
 * Paired in order, with both ends free to move, because the ends are where a real
 * session differs from the plan: one stopped early — aborted, or the cooldown
 * skipped — leaves the last steps with no lap at all, and one that carried on past
 * the end — a jog home, the file closing — leaves a lap with no step. Neither is a
 * reason to withhold the reps in the middle, which are the part anybody is asking
 * about, so the one lap past the end is held out rather than counted against them.
 *
 * What *is* withheld is a mapping that has drifted. A lap press missed halfway
 * through puts every later lap against the wrong step, and a mapping shifted by one
 * is worse than none: it reads as a confident, wrong verdict. So the pairing is
 * accepted on the weight of the evidence — most pairs have to be the length they
 * were written — rather than on the counts agreeing.
 */
function alignToPlan(planned: PlannedStep[], laps: LapStats[]): Array<PlannedStep | undefined> {
  const last = planned.length - 1;
  const none: Array<PlannedStep | undefined> = laps.map(() => undefined);
  if (last < 0) return none;

  // Held out before anything is weighed: it is nobody's step, and counted as a pair
  // that failed it can outvote the session around it. See docs/stats.md.
  const considered = tailBeyondPlan(planned, laps) ? laps.slice(0, -1) : laps;

  let best: Array<PlannedStep | undefined> = considered.map(() => undefined);
  let bestScore = 0;

  // Offset 0 is the session as it should have been recorded; the rest are the laps a
  // watch collects before the athlete sets off, which belong to no step at all.
  for (let offset = 0; offset <= Math.min(FALSE_STARTS, considered.length - 1); offset += 1) {
    const attempt = considered.map((_lap, index) =>
      index < offset ? undefined : planned[Math.min(index - offset, last)],
    );
    const paired = attempt.filter((step) => step !== undefined).length;
    const lining = attempt.filter((step, index) => Boolean(step && matches(step, considered[index]))).length;

    // An offset claims some of the recording is junk, which takes more than one lap
    // happening to be the right length to believe.
    if (lining >= (offset === 0 ? 1 : 2) && lining * 2 > paired && lining > bestScore) {
      best = attempt;
      bestScore = lining;
    }
  }
  return best.length === laps.length ? best : [...best, undefined];
}

/**
 * One lap more than the plan has steps, and what that last lap is.
 *
 * `stop` is the scrap a watch closes the file with when the athlete presses stop: seconds
 * long, no execution in it, not training. `extra` is real work past the end of the plan —
 * a jog home, a few more minutes spinning.
 *
 * Only a lap the plan has no step left for can be either. A session that ends *short* of
 * its plan ends on a real step run badly — 120 m of a planned kilometre — and that lap is
 * the cooldown however little of it was done, which is the thing the loose confidence bar
 * exists to report. The exception to `stop` is a last step itself that short — strides —
 * where a lap of the same length is that step again rather than the file closing.
 */
function tailBeyondPlan(planned: PlannedStep[], laps: LapStats[]): 'stop' | 'extra' | null {
  const tail = laps[laps.length - 1];
  if (laps.length !== planned.length + 1 || tail === undefined) return null;
  if ((tail.duration_s ?? 0) >= SHORT_LAP_S) return 'extra';
  return matches(planned[planned.length - 1], tail) ? null : 'stop';
}

/** The bounds a target puts on a metric we can measure without knowing the athlete's thresholds. */
function bandOf(target: Target): { metric: Metric; low: number; high: number } | null {
  switch (target.type) {
    case 'heart_rate':
      if (target.low?.unit !== 'bpm' || target.high?.unit !== 'bpm') return null;
      return { metric: 'hr', low: target.low.value, high: target.high.value };
    case 'speed':
      if (target.low === null || target.high === null) return null;
      // Their `low` is the slower speed, so it is the *slower* pace: the bounds swap ends.
      return { metric: 'pace_s_km', low: Math.round(1000 / target.high), high: Math.round(1000 / target.low) };
    case 'power':
      if (target.low?.unit !== 'watts' || target.high?.unit !== 'watts') return null;
      return { metric: 'power_w', low: target.low.value, high: target.high.value };
    case 'cadence':
      if (target.low === null || target.high === null) return null;
      return { metric: 'cadence', low: target.low, high: target.high };
    // A zone, or a percentage of a threshold, is a number only the platform holds.
    default:
      return null;
  }
}

// --- The figures -------------------------------------------------------------

/** The mean of what was actually recorded, or null where nothing in the quarter was. */
const mean = (values: Array<number | null>): number | null => {
  const recorded = values.filter((value): value is number => value !== null);
  if (recorded.length === 0) return null;
  return Math.round(recorded.reduce((sum, value) => sum + value, 0) / recorded.length);
};

/**
 * The lowest and highest a metric got, over what was actually recorded.
 *
 * A summary message is meant to carry these and often does not — a platform that builds
 * its FIT out of streams leaves half of them empty — so the stream answers instead.
 */
function spanOf(samples: Sample[], metric: Metric): { low: number | null; high: number | null } {
  let low: number | null = null;
  let high: number | null = null;

  for (const sample of samples) {
    const value = sample[metric];
    if (value === null) continue;
    if (low === null || value < low) low = value;
    if (high === null || value > high) high = value;
  }
  return { low, high };
}

/**
 * What the ground did across a run of samples.
 *
 * `net` is the end minus the start, which is one subtraction and so immune to the noise
 * that makes `gain` and `loss` the hard ones: those count a move only once it clears
 * `ELEVATION_NOISE_M` from wherever the last one was counted from.
 */
function climbOf(samples: Sample[]): { net: number | null; gain: number | null; loss: number | null } {
  const climbed = samples.filter((sample): sample is Sample & { altitude: number } => sample.altitude !== null);
  if (climbed.length === 0) return { net: null, gain: null, loss: null };

  let gain = 0;
  let loss = 0;
  let from = climbed[0].altitude;

  for (const sample of climbed) {
    if (sample.altitude - from >= ELEVATION_NOISE_M) gain += sample.altitude - from;
    else if (from - sample.altitude >= ELEVATION_NOISE_M) loss += from - sample.altitude;
    else continue;
    from = sample.altitude;
  }
  return { net: climbed[climbed.length - 1].altitude - climbed[0].altitude, gain, loss };
}

/** What a metric averaged over what was actually recorded, for a file that gave no average. */
const meanOf = (samples: Sample[], metric: Metric): number | null => mean(samples.map((sample) => sample[metric]));

/** How steep the ground was, over the distance actually covered on it. */
function gradeOf(samples: Sample[]): number | null {
  const net = climbOf(samples).net;
  const metres = samples.reduce((total, sample) => total + sample.metres, 0);
  return net === null || metres <= 0 ? null : round((net / metres) * 100, 1);
}

/** Joules: power over the moving seconds each sample stands for. */
function workOf(samples: Sample[]): number | null {
  let joules: number | null = null;
  for (const sample of samples) {
    if (sample.power_w === null) continue;
    joules = (joules ?? 0) + sample.power_w * sample.moving;
  }
  return joules;
}

/**
 * Normalized power: a rolling 30-second average, raised to the fourth, averaged, rooted.
 *
 * The number a ride is actually judged by, and the one most often missing from a file
 * built out of streams rather than written by the head unit. Coggan's method, computed
 * per sample rather than per second — a watch on smart recording has no per-second to
 * compute over — and refused outright for anything shorter than the window itself,
 * where it would mean nothing.
 */
function normalizedPowerOf(samples: Sample[]): number | null {
  const powered = samples.filter((sample) => sample.power_w !== null);
  if (powered.length === 0) return null;

  const start = powered[0].time;
  if (powered[powered.length - 1].time - start < NORMALIZED_WINDOW_S * 1000) return null;

  let rolling = 0;
  let quartic = 0;
  let counted = 0;
  let from = 0;

  for (const [index, sample] of powered.entries()) {
    rolling += sample.power_w!;
    while (powered[from].time < sample.time - NORMALIZED_WINDOW_S * 1000) {
      rolling -= powered[from].power_w!;
      from += 1;
    }
    // Nothing is counted until the window behind it is a full one.
    if (sample.time - start < NORMALIZED_WINDOW_S * 1000) continue;
    quartic += (rolling / (index - from + 1)) ** 4;
    counted += 1;
  }
  return counted === 0 ? null : Math.round((quartic / counted) ** 0.25);
}

/** Four equal segments of moving time, or of distance where the step was written in it. */
function quartersOf(samples: Sample[], splitBy: 'time' | 'distance'): Quarters | null {
  const weights = samples.map((sample) => (splitBy === 'time' ? sample.moving : sample.metres));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return null;

  const buckets: Sample[][] = [[], [], [], []];
  let cumulative = 0;
  for (const [index, sample] of samples.entries()) {
    // The middle of what this sample stands for, so a long one lands where most of it is.
    const quarter = Math.min(3, Math.floor(((cumulative + weights[index] / 2) / total) * 4));
    cumulative += weights[index];
    buckets[quarter].push(sample);
  }

  const averaged = (metric: Metric): Array<number | null> | null => {
    const quarters = buckets.map((bucket) => mean(bucket.map((sample) => sample[metric])));
    return quarters.some((value) => value !== null) ? quarters : null;
  };

  const terrain = <T>(read: (bucket: Sample[]) => T | null): Array<T | null> | null => {
    const quarters = buckets.map(read);
    return quarters.some((value) => value !== null) ? quarters : null;
  };

  return {
    split_by: splitBy,
    hr: averaged('hr'),
    pace_s_km: averaged('pace_s_km'),
    power_w: averaged('power_w'),
    cadence: averaged('cadence'),
    // Why a quarter was slower than the one before it is often the hill it was run up.
    elev_net_m: terrain((bucket) => round(climbOf(bucket).net, 1)),
    grade_pct: terrain(gradeOf),
  };
}

/** Where the lap actually sat against its band, by moving time rather than by sample count. */
function timeInBand(samples: Sample[], band: { metric: Metric; low: number; high: number }): LapTarget | null {
  let inside = 0;
  let above = 0;
  let below = 0;

  for (const sample of samples) {
    const value = sample[band.metric];
    if (value === null) continue;
    // Every sample counts for at least an instant, or a lap of one long sample counts for nothing.
    const weight = Math.max(sample.moving, 1);
    if (value < band.low) below += weight;
    else if (value > band.high) above += weight;
    else inside += weight;
  }

  const total = inside + above + below;
  if (total === 0) return null;

  const share = (part: number): number => Math.round((part / total) * 100) / 100;
  return { ...band, pct_time_in_band: share(inside), pct_time_above: share(above), pct_time_below: share(below) };
}

function sessionOf(
  session: SessionMesg,
  sport: string | null,
  indoor: boolean,
  samples: Sample[],
): SessionStats {
  const hr = spanOf(samples, 'hr');
  const power = spanOf(samples, 'power_w');

  const avgPower = positive(session.avgPower) ?? meanOf(samples, 'power_w');
  const normalized = positive(session.normalizedPower) ?? normalizedPowerOf(samples);
  const work = positive(session.totalWork) ?? workOf(samples);

  return {
    sport,
    sub_sport: typeof session.subSport === 'string' ? session.subSport : null,
    indoor,
    start_time: iso(session.startTime),
    elapsed_s: round(number(session.totalElapsedTime)),
    moving_s: round(number(session.totalMovingTime) ?? number(session.totalTimerTime)),
    timer_s: round(number(session.totalTimerTime)),
    distance_m: round(positive(session.totalDistance), 1),
    avg_hr: positive(session.avgHeartRate) ?? meanOf(samples, 'hr'),
    max_hr: positive(session.maxHeartRate) ?? hr.high,
    min_hr: positive(session.minHeartRate) ?? hr.low,
    avg_pace_s_km: paceOf(number(session.enhancedAvgSpeed) ?? number(session.avgSpeed)),
    // Already on the athlete's scale in the samples, so it is not converted a second time.
    avg_cadence: round(cadenceOf(positive(session.avgCadence), sport) ?? meanOf(samples, 'cadence')),
    avg_power_w: round(avgPower),
    max_power_w: round(positive(session.maxPower) ?? power.high),
    normalized_power_w: round(normalized),
    work_kj: round(work === null ? null : work / 1000),
    variability_index: round(avgPower !== null && normalized !== null ? normalized / avgPower : null, 3),
    total_ascent_m: round(number(session.totalAscent) ?? climbOf(samples).gain),
    total_descent_m: round(number(session.totalDescent) ?? climbOf(samples).loss),
    calories: positive(session.totalCalories),
  };
}

// --- The whole payload -------------------------------------------------------

/** Everything worth keeping out of one recorded FIT file, mapped against the plan it was for. */
export function statsFrom(
  bytes: Uint8Array,
  workout: Workout,
  source: Source,
  now: Date = new Date(),
): WorkoutStats {
  const stream = Stream.fromByteArray(bytes);
  if (!Decoder.isFIT(stream)) throw new StatsError('what the platform sent is not a FIT file');

  const { messages } = new Decoder(stream).read();
  const session = messages.sessionMesgs?.[0];
  if (!session) throw new StatsError('the recording carries no session to read');

  const sport = typeof session.sport === 'string' ? session.sport : null;
  const records = messages.recordMesgs ?? [];
  const flags: string[] = [];

  // Read twice: how often this device wrote a record decides what a pause is, and that
  // has to be known before the first sample's weight can be.
  const times = records.map((record) => at(record.timestamp));
  const gaps: number[] = [];
  for (const [index, time] of times.entries()) {
    const before = times[index - 1];
    if (index > 0 && before != null && time != null) gaps.push((time - before) / 1000);
  }
  const pauseGap = pauseGapOf(gaps);

  // Every sample, with the gap back to the one before it as the time it stands for.
  const samples: Sample[] = [];
  let previous: number | null = null;
  let covered: number | null = null;
  let positions = 0;
  let withHr = 0;
  for (const record of records) {
    const time = at(record.timestamp);
    if (time === null) continue;

    const gap = previous === null ? 0 : (time - previous) / 1000;
    if (gap > LONG_PAUSE_S && !flags.includes('long_pause')) flags.push('long_pause');
    previous = time;

    // `distance` counts from the start of the session, so the sample's own is the step.
    const distance = number(record.distance);
    const metres = distance === null || covered === null ? 0 : Math.max(0, distance - covered);
    covered = distance ?? covered;

    if (number(record.positionLat) !== null) positions += 1;
    const hr = positive(record.heartRate);
    if (hr !== null) withHr += 1;

    samples.push({
      time,
      moving: gap > pauseGap ? 0 : gap,
      metres,
      hr,
      altitude: number(record.enhancedAltitude) ?? number(record.altitude),
      pace_s_km: paceOf(number(record.enhancedSpeed) ?? number(record.speed)),
      power_w: number(record.power),
      cadence: cadenceOf(positive(record.cadence), sport),
    });
  }

  const indoor = positions === 0;
  const planned = flattenPlan(workout);
  const lapMesgs = messages.lapMesgs ?? [];

  // Where one lap's records stop. Not its own timestamp: that is the moment the lap
  // ended, which the next lap's first record shares, so the split is made on starts.
  const endOf = (index: number): number => {
    const next = at(lapMesgs[index + 1]?.startTime);
    if (next !== null) return next;
    const end = at(lapMesgs[index].timestamp);
    return end === null ? Infinity : end + 1;
  };

  let cursor = 0;
  const measured = lapMesgs.map((lap, index) => {
    const start = at(lap.startTime);

    // Records arrive in order, so each lap takes the run of them inside its own window.
    const from = cursor;
    while (cursor < samples.length && samples[cursor].time < endOf(index)) cursor += 1;
    const mine = samples.slice(from, cursor).filter((sample) => start === null || sample.time >= start);

    const stats: LapStats = {
      index,
      trigger: typeof lap.lapTrigger === 'string' ? lap.lapTrigger : null,
      role: ROLE_BY_INTENSITY[String(lap.intensity)] ?? 'unclassified',
      rep_number: null,
      planned_step_index: null,
      planned_step_name: null,
      match_confidence: 'unmatched',
      duration_s: round(number(lap.totalElapsedTime)),
      moving_s: round(number(lap.totalMovingTime) ?? number(lap.totalTimerTime)),
      distance_m: round(positive(lap.totalDistance), 1),
      avg_hr: positive(lap.avgHeartRate) ?? meanOf(mine, 'hr'),
      max_hr: positive(lap.maxHeartRate) ?? spanOf(mine, 'hr').high,
      min_hr: positive(lap.minHeartRate) ?? spanOf(mine, 'hr').low,
      avg_pace_s_km: paceOf(number(lap.enhancedAvgSpeed) ?? number(lap.avgSpeed)),
      avg_cadence: round(cadenceOf(positive(lap.avgCadence), sport) ?? meanOf(mine, 'cadence')),
      avg_power_w: round(positive(lap.avgPower) ?? meanOf(mine, 'power_w')),
      max_power_w: round(positive(lap.maxPower) ?? spanOf(mine, 'power_w').high),
      normalized_power_w: round(positive(lap.normalizedPower) ?? normalizedPowerOf(mine)),
      elev_gain_m: round(number(lap.totalAscent) ?? climbOf(mine).gain),
      elev_loss_m: round(number(lap.totalDescent) ?? climbOf(mine).loss),
      elev_net_m: round(climbOf(mine).net, 1),
      avg_grade_pct: round(number(lap.avgGrade), 1) ?? gradeOf(mine),
      quarters: null,
      target: null,
      flags: [],
    };

    return { stats, samples: mine };
  });

  // The mapping is decided over the whole recording, so every lap is measured first.
  const laps = measured.map(({ stats }) => stats);
  const alignment = alignToPlan(planned, laps);

  for (const [index, { stats, samples: mine }] of measured.entries()) {
    const step = alignment[index];
    if (step) {
      stats.rep_number = step.rep_number;
      stats.planned_step_index = step.index;
      stats.planned_step_name = step.name;
      stats.match_confidence = within(step, stats, TOLERANCE.confidence) ? 'high' : 'low';
      stats.role = ROLE_BY_INTENSITY[step.intensity] ?? stats.role;
    }

    // Said out loud, because it is the one lap that is real training and matched to nothing.
    if (index === laps.length - 1 && tailBeyondPlan(planned, laps) === 'extra') {
      stats.flags.push('extra_lap');
    }

    // Quartering a stride measures noise, so a short lap keeps its averages and nothing else.
    if ((stats.duration_s ?? 0) < SHORT_LAP_S) {
      stats.flags.push('short_lap');
    } else {
      stats.quarters = quartersOf(mine, step?.duration.type === 'distance' ? 'distance' : 'time');
    }

    const band = step ? bandOf(step.target) : null;
    if (band) stats.target = timeInBand(mine, band);
  }

  const stats = sessionOf(session, sport, indoor, samples);

  if (stats.avg_hr === null && withHr === 0) flags.push('no_hr');
  else if (samples.length > 0 && withHr < samples.length * 0.9) flags.push('hr_dropout');
  if (!indoor && positions < samples.length * 0.9) flags.push('gps_dropout');
  if (stats.elapsed_s !== null && stats.moving_s !== null && stats.moving_s < stats.elapsed_s * 0.95) {
    flags.push('autopause_active');
  }
  if (planned.length > 0 && laps.length > 0 && alignment.every((step) => step === undefined)) {
    flags.push('laps_do_not_match_plan');
  }

  return { ...source, computed_at: now.toISOString(), session: stats, laps, flags };
}

/** The recording could not be fetched or read. Stored so a reader is told, and so the asking ends. */
export const statsUnreadable = (
  source: Source,
  reason: string,
  attempts: number,
  now: Date = new Date(),
): WorkoutStats => ({
  ...source,
  computed_at: now.toISOString(),
  session: null,
  laps: [],
  flags: ['source_unreadable'],
  error: reason,
  attempts,
});

/** The laps dropped: what a workout row carries, and what every read but one asks for. */
export const sessionOnly = ({ laps: _laps, ...rest }: WorkoutStats): StatsSummary => rest;
