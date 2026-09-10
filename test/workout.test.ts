import { describe, expect, it } from 'vitest';
import { METRES_PER_MILE } from '../src/units';
import { WorkoutError, countSteps, normalizeWorkout } from '../src/workout';

const workout = (steps: unknown[]) => normalizeWorkout({ date: '2026-09-12', name: 'Test', steps });

/** Narrow a normalized step to the execution variant for assertions. */
const step = (result: ReturnType<typeof workout>, index = 0) => {
  const s = result.steps[index];
  if (s.kind !== 'step') throw new Error('expected an execution step');
  return s;
};

describe('workout basics', () => {
  it('defaults name, sport and intensity', () => {
    const result = normalizeWorkout({ date: '2026-09-12', steps: [{ goal_s: 600 }] });
    expect(result.sport).toBe('running');
    expect(result.name).toBe('Running 2026-09-12');
    expect(step(result).intensity).toBe('active');
  });

  it('rejects bad dates, unknown fields and empty step lists', () => {
    expect(() => normalizeWorkout({ date: '2026-02-31', steps: [{ goal_s: 60 }] })).toThrow(/not a real date/);
    expect(() => normalizeWorkout({ date: '2026-09-12', steps: [] })).toThrow(/at least one step/);
    expect(() => normalizeWorkout({ date: '2026-09-12', sport: 'quidditch', steps: [{ goal_s: 60 }] })).toThrow(
      /unknown sport/,
    );
    expect(() => workout([{ goal_secs: 60 }])).toThrow(/unknown field goal_secs/);
  });

  it('reports the path of the offending field', () => {
    try {
      workout([{ repeat: 2, steps: [{ goal_s: 60, target_heart_rate: [200, 150] }] }]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WorkoutError);
      expect((error as WorkoutError).path).toBe('steps[0].steps[0].target_heart_rate');
    }
  });

  it('allows only one duration and one target per step', () => {
    expect(() => workout([{ goal_s: 60, goal_meters: 400 }])).toThrow(/only have one duration/);
    expect(() => workout([{ goal_s: 60, target_heart_rate: 150, target_watts: 200 }])).toThrow(/only have one target/);
  });
});

describe('durations', () => {
  it('accepts seconds and mm:ss alike', () => {
    expect(step(workout([{ goal_s: 300 }])).duration).toEqual({ type: 'time', seconds: 300 });
    expect(step(workout([{ goal_s: '5:00' }])).duration).toEqual({ type: 'time', seconds: 300 });
    expect(step(workout([{ goal_s: '1:05:00' }])).duration).toEqual({ type: 'time', seconds: 3900 });
  });

  it('converts every distance unit to metres', () => {
    expect(step(workout([{ goal_meters: 400 }])).duration).toEqual({ type: 'distance', meters: 400 });
    expect(step(workout([{ goal_km: 5 }])).duration).toEqual({ type: 'distance', meters: 5000 });
    expect(step(workout([{ goal_miles: 1 }])).duration).toEqual({ type: 'distance', meters: METRES_PER_MILE });
  });

  it('runs until lap press when no duration is given', () => {
    expect(step(workout([{ name: 'Cooldown' }])).duration).toEqual({ type: 'open' });
  });

  it('supports heart-rate and power gates', () => {
    expect(step(workout([{ until_hr_below: 120 }])).duration).toEqual({
      type: 'hr_below',
      hr: { unit: 'bpm', value: 120 },
    });
    expect(step(workout([{ until_watts_above: '95%' }])).duration).toEqual({
      type: 'power_above',
      power: { unit: 'percent', value: 95 },
    });
  });
});

describe('targets', () => {
  it('converts a pace range to a speed range', () => {
    const target = step(workout([{ goal_meters: 400, target_pace_km: ['4:00', '4:15'] }])).target;
    expect(target.type).toBe('speed');
    if (target.type !== 'speed') return;
    expect(target.unit).toBe('km');
    // 4:15/km is the slow end, so it is the low speed.
    expect(target.low).toBeCloseTo(1000 / 255, 6);
    expect(target.high).toBeCloseTo(1000 / 240, 6);
  });

  it('reads a two-sided pace band the same either way round', () => {
    const ascending = step(workout([{ goal_s: 60, target_pace_km: ['4:00', '4:15'] }])).target;
    const descending = step(workout([{ goal_s: 60, target_pace_km: ['4:15', '4:00'] }])).target;
    expect(ascending).toEqual(descending);
  });

  it('reads "-" as an open end, in the direction the caller means', () => {
    // ["6:30", "-"] is "faster than 6:30/km": a floor on speed, no ceiling.
    const faster = step(workout([{ goal_s: 60, target_pace_km: ['6:30', '-'] }])).target;
    expect(faster).toMatchObject({ type: 'speed', high: null });
    if (faster.type === 'speed') expect(faster.low).toBeCloseTo(1000 / 390, 6);

    // ["-", "8:00"] is "slower than 8:00/km": a ceiling on speed, no floor.
    const slower = step(workout([{ goal_s: 60, target_pace_km: ['-', '8:00'] }])).target;
    expect(slower).toMatchObject({ type: 'speed', low: null });
    if (slower.type === 'speed') expect(slower.high).toBeCloseTo(1000 / 480, 6);
  });

  it('handles miles the same way', () => {
    const target = step(workout([{ goal_s: 60, target_pace_miles: ['7:00', '-'] }])).target;
    if (target.type !== 'speed') throw new Error('expected a speed target');
    expect(target.unit).toBe('mi');
    expect(target.low).toBeCloseTo(METRES_PER_MILE / 420, 6);
  });

  it('rejects a reversed heart-rate range, where order is unambiguous', () => {
    expect(() => workout([{ goal_s: 60, target_heart_rate: [160, 140] }])).toThrow(/reversed/);
  });

  it('takes heart rate as bpm or a percentage of max', () => {
    expect(step(workout([{ goal_s: 60, target_heart_rate: [146, 153] }])).target).toEqual({
      type: 'heart_rate',
      low: { unit: 'bpm', value: 146 },
      high: { unit: 'bpm', value: 153 },
    });
    expect(step(workout([{ goal_s: 60, target_heart_rate: ['80%', '90%'] }])).target).toEqual({
      type: 'heart_rate',
      low: { unit: 'percent', value: 80 },
      high: { unit: 'percent', value: 90 },
    });
    expect(step(workout([{ goal_s: 60, target_heart_rate: ['-', 150] }])).target).toEqual({
      type: 'heart_rate',
      low: null,
      high: { unit: 'bpm', value: 150 },
    });
  });

  it('takes power as watts or a percentage of FTP', () => {
    expect(step(workout([{ goal_s: 60, target_watts: [200, 240] }])).target).toEqual({
      type: 'power',
      low: { unit: 'watts', value: 200 },
      high: { unit: 'watts', value: 240 },
    });
    expect(step(workout([{ goal_s: 60, target_watts: '105%' }])).target).toEqual({
      type: 'power',
      low: { unit: 'percent', value: 105 },
      high: { unit: 'percent', value: 105 },
    });
  });

  it('takes zones, defaulting to heart rate', () => {
    expect(step(workout([{ goal_s: 60, target_zone: 3 }])).target).toEqual({
      type: 'zone',
      metric: 'heart_rate',
      zone: 3,
    });
    expect(step(workout([{ goal_s: 60, target_power_zone: 4 }])).target).toEqual({
      type: 'zone',
      metric: 'power',
      zone: 4,
    });
    expect(step(workout([{ goal_s: 60, target_zone: { type: 'pace', zone: 7 } }])).target).toEqual({
      type: 'zone',
      metric: 'pace',
      zone: 7,
    });
    expect(() => workout([{ goal_s: 60, target_hr_zone: 9 }])).toThrow(/between 1 and 5/);
  });

  it('leaves a step open when no target is given', () => {
    expect(step(workout([{ goal_s: 60 }])).target).toEqual({ type: 'open' });
  });
});

describe('repeats', () => {
  const intervals = workout([
    { name: 'Warmup', goal_s: 600, target_heart_rate: [146, 153] },
    {
      repeat: 8,
      steps: [
        { name: 'Fast', goal_meters: 400, target_pace_km: ['4:00', '4:15'] },
        { name: 'Float', goal_s: 90 },
      ],
    },
    { name: 'Cooldown', goal_s: 600 },
  ]);

  it('nests the repeated steps', () => {
    const repeat = intervals.steps[1];
    expect(repeat.kind).toBe('repeat');
    if (repeat.kind !== 'repeat') return;
    expect(repeat.times).toBe(8);
    expect(repeat.steps).toHaveLength(2);
  });

  it('counts the repeat itself as a step', () => {
    // warmup + (repeat + 2 children) + cooldown
    expect(countSteps(intervals.steps)).toBe(5);
  });

  it('accepts the verbose form too', () => {
    const result = workout([{ type: 'repeat', times: 3, steps: [{ goal_s: 60 }] }]);
    expect(result.steps[0]).toMatchObject({ kind: 'repeat', times: 3 });
  });

  it('needs steps to repeat, and will not nest forever', () => {
    expect(() => workout([{ repeat: 4, steps: [] }])).toThrow(/at least one step to repeat/);
    const deep = (depth: number): unknown => (depth === 0 ? { goal_s: 60 } : { repeat: 2, steps: [deep(depth - 1)] });
    expect(() => workout([deep(5)])).toThrow(/nest more than/);
  });
});

describe('intensity inference', () => {
  it('reads the step name', () => {
    const result = workout([
      { name: 'Warmup', goal_s: 600 },
      { name: 'Cool down', goal_s: 600 },
      { name: 'Recovery jog', goal_s: 60 },
    ]);
    expect(step(result, 0).intensity).toBe('warmup');
    expect(step(result, 1).intensity).toBe('cooldown');
    expect(step(result, 2).intensity).toBe('recovery');
  });

  it('assumes steps inside a repeat are intervals', () => {
    const result = workout([{ repeat: 4, steps: [{ goal_meters: 400 }] }]);
    const repeat = result.steps[0];
    if (repeat.kind !== 'repeat' || repeat.steps[0].kind !== 'step') throw new Error('expected a nested step');
    expect(repeat.steps[0].intensity).toBe('interval');
  });

  it('is overridden by an explicit intensity', () => {
    expect(step(workout([{ name: 'Warmup', goal_s: 600, intensity: 'active' }])).intensity).toBe('active');
    expect(() => workout([{ goal_s: 60, intensity: 'brisk' }])).toThrow(/unknown intensity/);
  });
});
