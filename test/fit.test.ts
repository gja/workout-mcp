import { Decoder, Stream } from '@garmin/fitsdk';
import { describe, expect, it } from 'vitest';
import { encodeWorkoutFit, fitFilename, flattenSteps } from '../src/fit';
import { normalizeWorkout } from '../src/workout';
import type { Workout } from '../src/workout';

const build = (steps: unknown[], overrides: Partial<Workout> = {}): Workout => ({
  version: 1,
  id: 'a1b2c3d4',
  updated_at: '2026-09-10T00:00:00.000Z',
  ...normalizeWorkout({ date: '2026-09-12', name: 'Session', steps }),
  ...overrides,
});

type DecodedMesg = Record<string, unknown>;
type Decoded = { bytes: Uint8Array } & Record<string, DecodedMesg[]>;

/** Encode, then read back through the SDK's own decoder. */
function roundTrip(workout: Workout): Decoded {
  const bytes = encodeWorkoutFit(workout, new Date('2026-09-10T00:00:00Z'));
  const stream = Stream.fromByteArray(bytes);
  expect(Decoder.isFIT(stream)).toBe(true);

  const decoder = new Decoder(stream);
  expect(decoder.checkIntegrity()).toBe(true);
  const { messages, errors } = decoder.read();
  expect(errors).toEqual([]);
  return { bytes, ...(messages as Record<string, DecodedMesg[]>) } as Decoded;
}

describe('file structure', () => {
  it('writes a workout file the SDK can read back', () => {
    const result = roundTrip(build([{ name: 'Easy', goal_s: 1800 }]));
    expect(result.fileIdMesgs[0]).toMatchObject({ type: 'workout', manufacturer: 'development' });
    expect(result.workoutMesgs[0]).toMatchObject({ wktName: 'Session', sport: 'running', numValidSteps: 1 });
  });

  it('names the download after the date and id', () => {
    expect(fitFilename({ date: '2026-09-12', id: 'a1b2c3d4' })).toBe('2026-09-12-a1b2c3d4.fit');
  });

  it('gives every sport its FIT equivalent', () => {
    const workout = build([{ goal_s: 60 }], { sport: 'cycling' });
    expect(roundTrip(workout).workoutMesgs[0]).toMatchObject({ sport: 'cycling' });
  });
});

describe('durations', () => {
  it('scales time to milliseconds and distance to centimetres', () => {
    const steps = roundTrip(build([{ goal_s: 600 }, { goal_meters: 400 }])).workoutStepMesgs;
    // The decoder applies the profile's scaling, so these come back in
    // seconds and metres — proof the encoder wrote the scaled values.
    expect(steps[0]).toMatchObject({ durationType: 'time', durationTime: 600 });
    expect(steps[1]).toMatchObject({ durationType: 'distance', durationDistance: 400 });
  });

  it('writes an open step for a lap-button press', () => {
    expect(roundTrip(build([{ name: 'Cooldown' }])).workoutStepMesgs[0]).toMatchObject({ durationType: 'open' });
  });

  it('encodes heart-rate gates with the +100 bpm offset', () => {
    const steps = roundTrip(build([{ until_hr_below: 120 }, { until_hr_above: '85%' }])).workoutStepMesgs;
    expect(steps[0]).toMatchObject({ durationType: 'hrLessThan', durationHr: 220 });
    // 0-100 is a percentage of max HR, so it is written unchanged.
    expect(steps[1]).toMatchObject({ durationType: 'hrGreaterThan', durationHr: 85 });
  });
});

describe('targets', () => {
  it('writes a pace range as a speed range in m/s', () => {
    const step = roundTrip(build([{ goal_meters: 400, target_pace_km: ['4:00', '4:15'] }])).workoutStepMesgs[0];
    expect(step).toMatchObject({ targetType: 'speed', targetValue: 0 });
    expect(step.customTargetSpeedLow as number).toBeCloseTo(1000 / 255, 2);
    expect(step.customTargetSpeedHigh as number).toBeCloseTo(1000 / 240, 2);
  });

  it('fills an open end with a bound no athlete reaches', () => {
    // "faster than 6:30/km": a real floor on speed, and a ceiling nobody hits.
    const faster = roundTrip(build([{ goal_s: 60, target_pace_km: ['6:30', '-'] }])).workoutStepMesgs[0];
    expect(faster.customTargetSpeedLow as number).toBeCloseTo(1000 / 390, 2);
    expect(faster.customTargetSpeedHigh as number).toBeCloseTo(25, 2);

    const under = roundTrip(build([{ goal_s: 60, target_heart_rate: ['-', 150] }])).workoutStepMesgs[0];
    expect(under).toMatchObject({ customTargetHeartRateLow: 0, customTargetHeartRateHigh: 250 });
  });

  it('offsets heart rate by 100 and power by 1000', () => {
    const hr = roundTrip(build([{ goal_s: 60, target_heart_rate: [146, 153] }])).workoutStepMesgs[0];
    expect(hr).toMatchObject({ targetType: 'heartRate', customTargetHeartRateLow: 246, customTargetHeartRateHigh: 253 });

    const watts = roundTrip(build([{ goal_s: 60, target_watts: [200, 240] }])).workoutStepMesgs[0];
    expect(watts).toMatchObject({ targetType: 'power', customTargetPowerLow: 1200, customTargetPowerHigh: 1240 });

    const ftp = roundTrip(build([{ goal_s: 60, target_watts: ['90%', '105%'] }])).workoutStepMesgs[0];
    expect(ftp).toMatchObject({ customTargetPowerLow: 90, customTargetPowerHigh: 105 });
  });

  it('writes zones as the target value, not a custom range', () => {
    const step = roundTrip(build([{ goal_s: 60, target_zone: 3 }])).workoutStepMesgs[0];
    expect(step).toMatchObject({ targetType: 'heartRate', targetHrZone: 3 });
    expect(step.customTargetValueLow).toBeUndefined();
  });
});

describe('repeats', () => {
  const intervals = build([
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

  it('flattens to FIT order with the repeat after its children', () => {
    const steps = roundTrip(intervals).workoutStepMesgs;
    expect(steps.map((s: DecodedMesg) => s.wktStepName ?? s.durationType)).toEqual([
      'Warmup',
      'Fast',
      'Float',
      'repeatUntilStepsCmplt',
      'Cooldown',
    ]);
    expect(steps.map((s: DecodedMesg) => s.messageIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it('points the repeat back at its first child and carries the count', () => {
    const repeat = roundTrip(intervals).workoutStepMesgs[3];
    expect(repeat).toMatchObject({ durationStep: 1, repeatSteps: 8 });
  });

  it('counts the repeat step in numValidSteps', () => {
    expect(roundTrip(intervals).workoutMesgs[0]).toMatchObject({ numValidSteps: 5 });
  });

  it('handles nested repeats', () => {
    const nested = build([
      { repeat: 2, steps: [{ name: 'A', goal_s: 30 }, { repeat: 3, steps: [{ name: 'B', goal_s: 10 }] }] },
    ]);
    const flat = flattenSteps(nested.steps);
    expect(flat.map((s) => s.wktStepName ?? s.durationType)).toEqual([
      'A',
      'B',
      'repeatUntilStepsCmplt', // inner: 3x B
      'repeatUntilStepsCmplt', // outer: 2x [A, inner]
    ]);
    expect(flat[2]).toMatchObject({ durationValue: 1, targetValue: 3 });
    expect(flat[3]).toMatchObject({ durationValue: 0, targetValue: 2 });
  });
});
