import { describe, expect, it } from 'vitest';
import { STATS_ATTEMPTS, STATS_RETRY_AFTER_MS, worthReading } from '../src/platforms';
import { statsFrom, statsUnreadable } from '../src/stats';
import type { WorkoutStats } from '../src/stats';
import type { Workout } from '../src/workout';
import { encodeActivityFit } from './activity-fit';
import type { ActivitySpec, LapSpec } from './activity-fit';

const SOURCE = { platform: 'intervals', activity_id: 'i44031892' };

const workout = (steps: Workout['steps']): Workout => ({
  id: 'a1b2c3d4',
  date: '2026-09-07',
  name: 'Threshold',
  sport: 'running',
  steps,
  updated_at: '2026-09-07T07:00:00.000Z',
});

/** Warmup, 3 x (4 min at threshold + 90 s jog), cooldown: eight steps flattened. */
const THRESHOLD_RUN = workout([
  { name: 'Warmup', goal_s: 600, target_heart_rate: [120, 140] },
  {
    repeat: 3,
    steps: [
      { name: 'Threshold', goal_s: 240, target_pace_km: ['4:00', '4:15'] },
      { name: 'Jog', goal_s: 90, intensity: 'recovery' },
    ],
  },
  { name: 'Cooldown', goal_s: 300 },
]);

/** The same session, run as planned: 4:05/km reps against 6:00/km around them. */
const AS_PLANNED: ActivitySpec = {
  laps: [
    { seconds: 600, speed: 2.8, hr: [100, 140], cadence: 80 },
    ...[0, 1, 2].flatMap((): LapSpec[] => [
      { seconds: 240, speed: 1000 / 245, hr: [145, 165], cadence: 88 },
      { seconds: 90, speed: 2.6, hr: [165, 132], cadence: 78 },
    ]),
    { seconds: 300, speed: 2.6, hr: [130, 115], cadence: 78 },
  ],
};

const read = (spec: ActivitySpec, plan = THRESHOLD_RUN) => statsFrom(encodeActivityFit(spec), plan, SOURCE);

describe('reading a recorded session', () => {
  it('names where it came from and when it was read', () => {
    const stats = read(AS_PLANNED, workout([{ goal_s: 600 }]));
    expect(stats.platform).toBe('intervals');
    expect(stats.activity_id).toBe('i44031892');
    expect(Date.parse(stats.computed_at)).not.toBeNaN();
  });

  it('totals the session', () => {
    const { session } = read(AS_PLANNED);
    expect(session).not.toBeNull();
    expect(session!.sport).toBe('running');
    expect(session!.elapsed_s).toBe(1890);
    expect(session!.indoor).toBe(false);
    expect(session!.max_hr).toBe(165);
    // 80 cycles a minute is 160 strides, which is what an athlete counts.
    expect(session!.avg_cadence).toBeGreaterThan(150);
    expect(session!.avg_pace_s_km).toBeGreaterThan(0);
  });

  it('maps every lap to the planned step it was for', () => {
    const { laps, flags } = read(AS_PLANNED);

    expect(laps).toHaveLength(8);
    expect(flags).not.toContain('laps_do_not_match_plan');
    expect(laps.map((lap) => lap.planned_step_index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(laps.map((lap) => lap.planned_step_name)).toEqual([
      'Warmup', 'Threshold', 'Jog', 'Threshold', 'Jog', 'Threshold', 'Jog', 'Cooldown',
    ]);
    // The rep a lap belongs to is the plan's, not a guess from how the laps were pressed.
    expect(laps.map((lap) => lap.rep_number)).toEqual([null, 1, 1, 2, 2, 3, 3, null]);
    expect(laps.map((lap) => lap.role)).toEqual([
      'warmup', 'work', 'recovery', 'work', 'recovery', 'work', 'recovery', 'cooldown',
    ]);
    expect(laps.every((lap) => lap.match_confidence === 'high')).toBe(true);
  });

  it('quarters each lap, in the order they were run', () => {
    const { laps } = read(AS_PLANNED);
    const rep = laps[1];

    expect(rep.quarters?.split_by).toBe('time');
    expect(rep.quarters?.hr).toHaveLength(4);
    // Heart rate is still climbing through a rep, and that ramp is the signal.
    expect(rep.quarters!.hr!.map(Number)).toEqual([...rep.quarters!.hr!.map(Number)].sort((a, b) => a - b));
    expect(rep.quarters?.pace_s_km).toEqual([245, 245, 245, 245]);
    expect(rep.quarters?.power_w).toBeNull();

    // How far heart rate falls on the jog is invisible in the average.
    expect(laps[2].min_hr).toBe(132);
    expect(laps[2].quarters!.hr![0]).toBeGreaterThan(laps[2].quarters!.hr![3]!);
  });

  it('says how much of a lap sat inside its target band', () => {
    const { laps } = read(AS_PLANNED);

    // 4:00-4:15/km, run at 4:05.
    expect(laps[1].target).toEqual({
      metric: 'pace_s_km',
      low: 240,
      high: 255,
      pct_time_in_band: 1,
      pct_time_above: 0,
      pct_time_below: 0,
    });
    // The warmup's target is heart rate, and it starts below the band.
    expect(laps[0].target?.metric).toBe('hr');
    expect(laps[0].target!.pct_time_below).toBeGreaterThan(0);
    // A step with no target of its own gets no band invented for it.
    expect(laps[7].target).toBeNull();
  });

  it('reports a rep that faded rather than averaging it away', () => {
    const faded: ActivitySpec = {
      laps: [
        { seconds: 600, speed: 2.8, hr: [100, 140] },
        // Starts inside the band at 4:05 and drifts out to 4:40.
        { seconds: 240, speed: 1000 / 245, hr: [145, 160] },
        { seconds: 90, speed: 2.6, hr: [160, 130] },
        { seconds: 240, speed: 1000 / 280, hr: [150, 168] },
        { seconds: 90, speed: 2.6, hr: [168, 138] },
        { seconds: 240, speed: 1000 / 280, hr: [152, 170] },
        { seconds: 90, speed: 2.6, hr: [170, 140] },
        { seconds: 300, speed: 2.6, hr: [135, 118] },
      ],
    };
    const { laps } = read(faded);

    expect(laps[3].target?.pct_time_in_band).toBe(0);
    expect(laps[3].target?.pct_time_above).toBe(1);
    expect(laps[3].match_confidence).toBe('high');
  });
});

describe('what the recording did not say', () => {
  it('reports a session with no heart rate as null, never zero', () => {
    const { session, laps, flags } = read({ laps: AS_PLANNED.laps.map(({ hr: _hr, ...rest }) => rest) });

    expect(flags).toContain('no_hr');
    expect(session!.avg_hr).toBeNull();
    expect(session!.max_hr).toBeNull();
    expect(laps.every((lap) => lap.avg_hr === null && lap.min_hr === null)).toBe(true);
    expect(laps.every((lap) => lap.quarters === null || lap.quarters.hr === null)).toBe(true);
    expect(JSON.stringify(laps)).not.toContain('_hr":0');
  });

  it('keeps a stride, and quarters nothing that short', () => {
    const strides = workout([{ repeat: 6, steps: [{ name: 'Stride', goal_s: 20 }] }]);
    const { laps } = statsFrom(
      encodeActivityFit({ laps: Array.from({ length: 6 }, () => ({ seconds: 20, speed: 5, hr: [140, 160] })) }),
      strides,
      SOURCE,
    );

    expect(laps).toHaveLength(6);
    expect(laps.every((lap) => lap.quarters === null)).toBe(true);
    expect(laps.every((lap) => lap.flags.includes('short_lap'))).toBe(true);
    // Suppressed quarters are not suppressed averages.
    expect(laps[0].avg_hr).toBeGreaterThan(0);
  });

  it('folds a lap run past the end into the step it overran', () => {
    // The cooldown was pressed in two: five minutes, then another eight jogging home.
    const extended: ActivitySpec = {
      laps: [...AS_PLANNED.laps, { seconds: 480, speed: 2.2, hr: [115, 105] }],
    };
    const { laps, flags } = read(extended);

    expect(flags).not.toContain('laps_do_not_match_plan');
    expect(laps).toHaveLength(9);
    // The reps are untouched, and both tail laps are the cooldown they belong to.
    expect(laps[1]).toMatchObject({ planned_step_name: 'Threshold', match_confidence: 'high' });
    expect(laps[7]).toMatchObject({ planned_step_index: 7, planned_step_name: 'Cooldown', role: 'cooldown' });
    expect(laps[8]).toMatchObject({ planned_step_index: 7, planned_step_name: 'Cooldown', role: 'cooldown' });
    // It is still not the step as written, and says so rather than claiming a clean hit.
    expect(laps[8].match_confidence).toBe('low');
  });

  it('matches what was run when the session stopped early', () => {
    // Aborted after the second rep: four laps against a plan of eight steps.
    const aborted: ActivitySpec = { laps: AS_PLANNED.laps.slice(0, 4) };
    const { laps, flags } = read(aborted);

    expect(flags).not.toContain('laps_do_not_match_plan');
    expect(laps.map((lap) => lap.planned_step_index)).toEqual([0, 1, 2, 3]);
    expect(laps.every((lap) => lap.match_confidence === 'high')).toBe(true);
    // The steps that were never run are simply absent; the plan says what is missing.
    expect(laps).toHaveLength(4);
  });

  it('matches the rest when the cooldown was skipped', () => {
    const noCooldown: ActivitySpec = { laps: AS_PLANNED.laps.slice(0, 7) };
    const { laps, flags } = read(noCooldown);

    expect(flags).not.toContain('laps_do_not_match_plan');
    expect(laps.map((lap) => lap.planned_step_name)).toEqual([
      'Warmup', 'Threshold', 'Jog', 'Threshold', 'Jog', 'Threshold', 'Jog',
    ]);
  });

  it('marks a cooldown cut short as the step it was, run short', () => {
    const shortened = { ...AS_PLANNED, laps: AS_PLANNED.laps.map((lap, index) => (index === 7 ? { ...lap, seconds: 70 } : lap)) };
    const { laps } = read(shortened);

    expect(laps[7]).toMatchObject({ planned_step_name: 'Cooldown', match_confidence: 'low' });
    // And the reps in front of it are untouched by the one that went wrong.
    expect(laps.slice(0, 7).every((lap) => lap.match_confidence === 'high')).toBe(true);
  });

  it('withholds the mapping when a missed lap press has shifted it', () => {
    // Nine laps again, but nothing was run to the length it was written: not a long cooldown.
    const muddle: ActivitySpec = {
      laps: Array.from({ length: 9 }, (): LapSpec => ({ seconds: 200, speed: 2.8, hr: [130, 150] })),
    };
    const { laps, flags } = read(muddle);

    expect(flags).toContain('laps_do_not_match_plan');
    expect(laps.every((lap) => lap.match_confidence === 'unmatched')).toBe(true);
  });

  it('refuses to guess when the laps do not line up with the plan', () => {
    const freestyle: ActivitySpec = { laps: [{ seconds: 1200, speed: 3 }, { seconds: 690, speed: 2.7 }] };
    const { laps, flags } = read(freestyle);

    expect(flags).toContain('laps_do_not_match_plan');
    expect(laps).toHaveLength(2);
    expect(laps.every((lap) => lap.match_confidence === 'unmatched')).toBe(true);
    expect(laps.every((lap) => lap.planned_step_index === null && lap.target === null)).toBe(true);
    // The numbers are still there; only the mapping is withheld.
    expect(laps[0].duration_s).toBe(1200);
  });

  it('marks a lap that ran to the wrong length as a low-confidence match', () => {
    const short = { ...AS_PLANNED, laps: AS_PLANNED.laps.map((lap, index) => (index === 1 ? { ...lap, seconds: 60 } : lap)) };
    const { laps } = read(short);

    expect(laps[1].match_confidence).toBe('low');
    expect(laps[1].planned_step_index).toBe(1);
    expect(laps[3].match_confidence).toBe('high');
  });

  // A watch on smart recording writes a sample every ten or fifteen seconds. Reading each
  // of those gaps as a stop left every lap with no moving time, and so no quarters at all.
  it('quarters a session recorded a sample every fifteen seconds', () => {
    const { laps } = read({ ...AS_PLANNED, interval: 15 });

    expect(laps[1].quarters?.hr).toHaveLength(4);
    expect(laps[1].quarters?.pace_s_km).toEqual([245, 245, 245, 245]);
    expect(laps[1].target?.pct_time_in_band).toBe(1);
    expect(laps.every((lap) => lap.quarters !== null)).toBe(true);
  });

  it('calls a session with no position indoor', () => {
    const { session, flags } = read({ ...AS_PLANNED, outdoor: false, subSport: 'treadmill' });

    expect(session!.indoor).toBe(true);
    expect(session!.sub_sport).toBe('treadmill');
    expect(flags).not.toContain('gps_dropout');
  });

  it('says so when the file could not be read at all', () => {
    expect(() => statsFrom(new Uint8Array([1, 2, 3, 4]), THRESHOLD_RUN, SOURCE)).toThrow(/not a FIT file/);

    const stats = statsUnreadable(SOURCE, 'intervals.icu answered 422', 1);
    expect(stats.session).toBeNull();
    expect(stats.laps).toEqual([]);
    expect(stats.flags).toEqual(['source_unreadable']);
    expect(stats.error).toBe('intervals.icu answered 422');
    expect(stats.attempts).toBe(1);
  });
});

describe('deciding whether to read a recording again', () => {
  const now = Date.parse('2026-09-07T12:00:00Z');
  const read = (fields: Partial<WorkoutStats> = {}): WorkoutStats => ({
    ...statsUnreadable(SOURCE, 'intervals.icu answered 500', 1, new Date(now)),
    ...fields,
  });

  it('reads one that has never been read', () => {
    expect(worthReading(undefined, 'i44031892', now)).toBe(true);
  });

  it('leaves one alone once it has been read', () => {
    const done = { ...read(), session: {} as never, flags: [], error: undefined, attempts: undefined };
    expect(worthReading(done, 'i44031892', now)).toBe(false);
  });

  // The athlete deleted a bad upload and did it again: the stored numbers are another session's.
  it('reads it again when the platform now names a different activity', () => {
    const done = { ...read(), session: {} as never, flags: [], error: undefined, attempts: undefined };
    expect(worthReading(done, 'i44039999', now)).toBe(true);
  });

  it('leaves a failure alone until it has had time to be something else', () => {
    expect(worthReading(read(), 'i44031892', now + 60_000)).toBe(false);
    expect(worthReading(read(), 'i44031892', now + STATS_RETRY_AFTER_MS + 1)).toBe(true);
  });

  it('stops asking once the tries are spent', () => {
    const spent = read({ attempts: STATS_ATTEMPTS });
    expect(worthReading(spent, 'i44031892', now + STATS_RETRY_AFTER_MS * 10)).toBe(false);
  });
});

describe('a ride whose file carries only the averages', () => {
  /** 8 min warmup, 2 x (10 min tempo + 4 min easy), 4 min cooldown — as intervals.icu builds it. */
  const TEMPO_RIDE = workout([
    { name: 'Warmup', goal_s: 480, target_watts: [118, 145] },
    {
      repeat: 2,
      steps: [
        { name: 'Tempo', goal_s: 600, target_watts: [155, 180] },
        { name: 'Easy', goal_s: 240, target_watts: [118, 145] },
      ],
    },
    { name: 'Cooldown', goal_s: 240, target_watts: [118, 145] },
  ]);

  const ridden = (power: LapSpec['power']): ActivitySpec => ({
    sport: 'cycling',
    subSport: 'indoorCycling',
    outdoor: false,
    laps: [
      { seconds: 480, power: 130, hr: [95, 140] },
      ...[0, 1].flatMap((): LapSpec[] => [
        { seconds: 600, power, hr: [145, 168] },
        { seconds: 240, power: 130, hr: [168, 140] },
      ]),
      { seconds: 240, power: 120, hr: [138, 110] },
    ],
  });

  const ride = (spec: ActivitySpec) => statsFrom(encodeActivityFit(spec), TEMPO_RIDE, SOURCE);

  /**
   * A minute at 115 W then a minute at 215 W: the same 165 average as riding it steadily.
   * The blocks are longer than the window on purpose — surging by the second is what a
   * thirty-second rolling average exists to smooth away, and it reads as steady.
   */
  const SURGING = [...Array<number>(60).fill(115), ...Array<number>(60).fill(215)];

  it('works out the normalized power the file did not carry', () => {
    // The same average, ridden steadily and ridden in surges.
    const steady = ride(ridden(165)).session!;
    const surging = ride(ridden(SURGING)).session!;

    expect(steady.avg_power_w).toBe(surging.avg_power_w);
    expect(steady.normalized_power_w).toBeCloseTo(steady.avg_power_w!, -1);
    // Riding the same average in surges costs more, which is the whole point of the number.
    expect(surging.normalized_power_w!).toBeGreaterThan(surging.avg_power_w! + 10);
  });

  it('leaves the file own figure alone where it has one', () => {
    const stated = ride({ ...ridden(SURGING), normalizedPower: 199 }).session!;
    expect(stated.normalized_power_w).toBe(199);
  });

  it('totals the work done, and the variability it was done with', () => {
    const { session } = ride(ridden(165));

    // Around 165 W for a little under 36 minutes.
    expect(session!.work_kj).toBeGreaterThan(330);
    expect(session!.work_kj).toBeLessThan(365);
    expect(session!.variability_index).toBeCloseTo(1, 1);
  });

  it('finds the peaks and troughs the summary left out', () => {
    const { session, laps } = ride(ridden(SURGING));

    expect(session!.max_power_w).toBe(215);
    expect(session!.min_hr).toBe(95);
    expect(session!.max_hr).toBe(168);

    // And per lap, which is where a rep is actually read.
    expect(laps[1].normalized_power_w!).toBeGreaterThan(laps[1].avg_power_w!);
    expect(laps[1].max_power_w).toBe(215);
    expect(laps[1].min_hr).toBe(145);
  });

  // Nothing to roll a thirty-second window over: a number would be made up rather than read.
  it('refuses a normalized power for a lap shorter than the window', () => {
    const sprints = workout([{ repeat: 4, steps: [{ name: 'Sprint', goal_s: 20 }] }]);
    const { laps } = statsFrom(
      encodeActivityFit({
        sport: 'cycling',
        laps: Array.from({ length: 4 }, (): LapSpec => ({ seconds: 20, power: 400 })),
      }),
      sprints,
      SOURCE,
    );

    expect(laps[0].normalized_power_w).toBeNull();
    expect(laps[0].max_power_w).toBe(400);
  });
});

describe('the ground a lap was run on', () => {
  /** One 20-minute steady block: the shape a long run's middle has. */
  const STEADY = workout([{ name: 'Steady', goal_s: 1200, target_pace_km: ['7:00', '7:30'] }]);

  /**
   * Run at an honest 7:10 for the first half and 7:50 for the third quarter, up a hill.
   *
   * Quarters alone read that as a fade. The point of carrying the terrain is that they
   * no longer have to be read alone.
   */
  const UP_AND_OVER: ActivitySpec = {
    laps: [
      { seconds: 300, speed: 1000 / 430, hr: [140, 145], climb: 1 },
      { seconds: 300, speed: 1000 / 430, hr: [145, 148], climb: 1 },
      { seconds: 300, speed: 1000 / 470, hr: [148, 158], climb: 32 },
      { seconds: 300, speed: 1000 / 425, hr: [158, 150], climb: -30 },
    ],
  };

  // One lap, four quarters: the same recording read as the single step it was planned as.
  const asOneLap = (): ActivitySpec => ({
    laps: [{ seconds: 1200, speed: 1000 / 430, hr: [140, 155], climb: 4 }],
  });

  it('says what the ground did in each quarter', () => {
    const { laps } = statsFrom(
      encodeActivityFit(UP_AND_OVER),
      workout([{ repeat: 4, steps: [{ name: 'Block', goal_s: 300 }] }]),
      SOURCE,
    );

    // The third block is slower, and the climb under it is why.
    expect(laps[2].avg_pace_s_km!).toBeGreaterThan(laps[1].avg_pace_s_km!);
    expect(laps[2].elev_net_m!).toBeGreaterThan(30);
    expect(laps[2].avg_grade_pct!).toBeGreaterThan(4);

    // And the way back down reads as the descent it was.
    expect(laps[3].elev_net_m!).toBeLessThan(-28);
    expect(laps[3].avg_grade_pct!).toBeLessThan(0);
  });

  it('carries the climb into the quarters, beside the pace it explains', () => {
    const climbing: ActivitySpec = {
      laps: [{ seconds: 1200, speed: 1000 / 430, hr: [140, 158], climb: 40 }],
    };
    const { laps } = statsFrom(encodeActivityFit(climbing), STEADY, SOURCE);
    const quarters = laps[0].quarters!;

    expect(quarters.elev_net_m).toHaveLength(4);
    expect(quarters.grade_pct).toHaveLength(4);
    // Evenly up over the lap, so every quarter climbs its share.
    expect(quarters.elev_net_m!.every((metres) => metres! > 8)).toBe(true);
    expect(quarters.grade_pct!.every((grade) => grade! > 0)).toBe(true);
  });

  // The whole reason the terrain is carried: one lap, four quarters, and a hill in the
  // third. Read on pace alone this is a session that faded; it is a session that climbed.
  it('shows the hill under a quarter that a fade would be blamed for', () => {
    const overTheHill: ActivitySpec = {
      laps: [
        {
          seconds: 1200,
          speed: [1000 / 428, 1000 / 430, 1000 / 478, 1000 / 424],
          hr: [140, 152],
          climb: [1, 1, 34, -33],
        },
      ],
    };
    const { quarters } = statsFrom(encodeActivityFit(overTheHill), STEADY, SOURCE).laps[0];

    // The third quarter is the slow one, by a lot.
    expect(quarters!.pace_s_km![2]!).toBeGreaterThan(quarters!.pace_s_km![1]! + 30);
    // And the fourth is quicker than the first, which a fade would never be.
    expect(quarters!.pace_s_km![3]!).toBeLessThan(quarters!.pace_s_km![0]!);

    // The ground says why, without anything here having to call it anything.
    expect(quarters!.elev_net_m![2]!).toBeGreaterThan(30);
    expect(quarters!.grade_pct![2]!).toBeGreaterThan(4);
    expect(quarters!.elev_net_m![3]!).toBeLessThan(-30);
  });

  it('leaves the terrain out where the recording never carried an altitude', () => {
    const { laps } = statsFrom(encodeActivityFit(asOneLap()), STEADY, SOURCE);
    expect(laps[0].quarters!.elev_net_m).not.toBeNull();

    const flat = statsFrom(encodeActivityFit({ laps: [{ seconds: 1200, speed: 2.3 }] }), STEADY, SOURCE);
    expect(flat.laps[0].quarters!.elev_net_m).toBeNull();
    expect(flat.laps[0].elev_net_m).toBeNull();
    expect(flat.laps[0].avg_grade_pct).toBeNull();
  });

  // A barometer wobbling a metre either way is not a staircase.
  it('does not turn sensor noise into climbing', () => {
    const noisy: ActivitySpec = { laps: [{ seconds: 1200, speed: 2.3, climb: 0, jitter: 1 }] };
    const { session, laps } = statsFrom(encodeActivityFit(noisy), STEADY, SOURCE);

    // Twenty minutes of wobble accumulates into nothing, which is the whole point.
    expect(laps[0].elev_gain_m).toBe(0);
    expect(session!.total_ascent_m).toBe(0);
    // Net is one subtraction, so it carries the noise on its own two ends and no more.
    expect(Math.abs(laps[0].elev_net_m!)).toBeLessThanOrEqual(2);
  });
});

describe('the lap a watch writes when the athlete presses stop', () => {
  /** One step, and the two laps a trainer session actually came back as. */
  const SPIN = workout([{ name: 'Recovery spin', goal_s: 2400, target_watts: [118, 145] }]);

  const spun = (tail: LapSpec[]): ActivitySpec => ({
    sport: 'cycling',
    subSport: 'indoorCycling',
    laps: [{ seconds: 2400, power: 125, cadence: 88, hr: [137, 149] }, ...tail],
  });

  it('does not let four seconds outvote the forty minutes before them', () => {
    const { laps, flags } = statsFrom(
      encodeActivityFit(spun([{ seconds: 4, power: 71, hr: [153, 153], trigger: 'time' }])),
      SPIN,
      SOURCE,
    );

    // One step and two laps: counted as a pair that failed, the scrap is half the evidence.
    expect(flags).not.toContain('laps_do_not_match_plan');
    expect(laps[0]).toMatchObject({ planned_step_name: 'Recovery spin', match_confidence: 'high' });
    // Dropped from the weighing, not mapped: it is not the recovery spin either.
    expect(laps[1]).toMatchObject({ match_confidence: 'unmatched', planned_step_name: null });
  });

  it('leaves a real last step alone, however little of it was done', () => {
    const strides = workout([{ name: 'Easy', goal_s: 600 }, { name: 'Strides', goal_s: 20 }]);
    const { laps } = statsFrom(
      encodeActivityFit({ laps: [{ seconds: 600, speed: 2.6 }, { seconds: 20, speed: 4.2 }] }),
      strides,
      SOURCE,
    );

    // As short as a stop lap, and the step the plan actually ends on.
    expect(laps[1]).toMatchObject({ planned_step_name: 'Strides', match_confidence: 'high' });
  });
});

describe('what the file left for the reader to work out', () => {
  /** A steady run with a cooldown, which is where the lengths stop lining up exactly. */
  const LONG_RUN = workout([
    { name: 'Warmup', goal_km: 1.5 },
    { name: 'Long run steady', goal_km: 4.5, target_pace_km: ['7:15', '7:30'] },
    { name: 'Cooldown', goal_km: 1 },
  ]);

  /** The cooldown as actually run: `metres` of a planned kilometre. */
  const asRun = (metres: number): ActivitySpec => ({
    laps: [
      { seconds: 683, speed: 1500 / 683, hr: [120, 140] },
      { seconds: 2004, speed: 4500 / 2004, hr: [143, 150] },
      { seconds: Math.round(metres / 2.28), speed: 2.28, hr: [150, 135] },
    ],
  });

  it('no longer says a session is in question for ending the way sessions end', () => {
    const { laps, flags } = statsFrom(encodeActivityFit(asRun(844)), LONG_RUN, SOURCE);

    expect(flags).not.toContain('laps_do_not_match_plan');
    expect(laps[2]).toMatchObject({ planned_step_name: 'Cooldown', match_confidence: 'high' });
    expect(laps.every((lap) => lap.match_confidence === 'high')).toBe(true);
  });

  // Still `low` where there is something to actually be unsure about.
  it('keeps low for a lap that ran a fraction of what it was written as', () => {
    const { laps } = statsFrom(encodeActivityFit(asRun(120)), LONG_RUN, SOURCE);

    expect(laps[2].planned_step_name).toBe('Cooldown');
    expect(laps[2].match_confidence).toBe('low');
  });

  /**
   * The extremes already fell back to the record stream; the averages did not, so a lap
   * the file did not summarise came back with a maximum and a minimum but no average.
   */
  it('averages what was recorded when the file summarised no part of the lap', () => {
    const unsummarised: ActivitySpec = {
      laps: [
        { seconds: 683, speed: 1500 / 683, hr: [120, 140], cadence: 86, power: 210 },
        { seconds: 2004, speed: 4500 / 2004, hr: [143, 150], cadence: 87, power: 220 },
        { seconds: 370, speed: 2.28, hr: [150, 150], cadence: 85, power: 190, noAverages: true },
      ],
    };
    const { laps, session } = statsFrom(encodeActivityFit(unsummarised), LONG_RUN, SOURCE);

    expect(laps[2].avg_hr).toBe(150);
    expect(laps[2].max_hr).toBe(150);
    expect(laps[2].min_hr).toBe(150);
    // The same rule, not three fixes: cadence and power fall back too.
    expect(laps[2].avg_cadence).toBe(170);
    expect(laps[2].avg_power_w).toBe(190);
    // And the session's own averages, for a file that summarises none of it.
    expect(session!.avg_hr).toBeGreaterThan(0);
  });

  // FTP lives on the athlete's platform profile, not in the file, so it was never once set.
  it('does not carry a field nothing could ever fill', () => {
    const { session } = statsFrom(encodeActivityFit(asRun(844)), LONG_RUN, SOURCE);
    expect(session).not.toHaveProperty('intensity_factor');
  });
});
