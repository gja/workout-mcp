import { Decoder, Stream } from '@garmin/fitsdk';
import { describe, expect, it } from 'vitest';
import { encodeWorkoutFit, fitFilename, flattenSteps } from '../src/fit';
import { resolveSteps } from '../src/resolve';
import { parseWorkout } from '../src/workout';
import type { Workout } from '../src/workout';

const build = (steps: unknown[], overrides: Partial<Workout> = {}): Workout => ({
  id: 'a1b2c3d4',
  updated_at: '2026-09-10T00:00:00.000Z',
  ...parseWorkout({ date: '2026-09-12', name: 'Session', steps }),
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

describe('the encoder buffer', () => {
  /**
   * The SDK asks for a resizable ArrayBuffer with a 500 MB maxByteLength.
   * Dev workerd allows it; production refuses it against the isolate memory
   * cap, and the encoder threw before writing a byte. Assert on the size we
   * ask for, since the environment that rejects it is not the one under test.
   */
  it('never reserves more than a megabyte', () => {
    const requested: number[] = [];
    const NativeArrayBuffer = globalThis.ArrayBuffer;

    class SpyArrayBuffer extends NativeArrayBuffer {
      constructor(length: number, options?: { maxByteLength?: number }) {
        if (options?.maxByteLength !== undefined) requested.push(options.maxByteLength);
        super(length, options as never);
      }
    }

    globalThis.ArrayBuffer = SpyArrayBuffer as unknown as ArrayBufferConstructor;
    try {
      roundTrip(build([{ goal_s: 1800, target_pace_km: ['6:00', '6:30'] }]));
    } finally {
      globalThis.ArrayBuffer = NativeArrayBuffer;
    }

    expect(requested.length, 'the encoder should have asked for a resizable buffer').toBeGreaterThan(0);
    expect(Math.max(...requested)).toBeLessThanOrEqual(1024 * 1024);
  });

  it('puts the global back, so nothing else sees the clamp', () => {
    const before = globalThis.ArrayBuffer;
    roundTrip(build([{ goal_s: 600 }]));
    expect(globalThis.ArrayBuffer).toBe(before);
  });
});

describe('file structure', () => {
  it('writes a workout file the SDK can read back', () => {
    const result = roundTrip(build([{ name: 'Easy', goal_s: 1800 }]));
    expect(result.fileIdMesgs[0]).toMatchObject({ type: 'workout', manufacturer: 'development' });
    expect(result.workoutMesgs[0]).toMatchObject({ wktName: 'Session', sport: 'running', numValidSteps: 1 });
  });

  it('names the download after the date and id', () => {
    expect(fitFilename({ date: '2026-09-12', id: 'a1b2c3d4' })).toBe('2026-09-12-a1b2c3d4.fit');
  });

  it('writes the description, so the watch shows what the session is for', () => {
    const workout = build([{ goal_s: 600 }], { notes: 'Steady aerobic hour, keep it conversational' });
    expect(roundTrip(workout).workoutMesgs[0]).toMatchObject({
      wktDescription: 'Steady aerobic hour, keep it conversational',
    });
  });

  it('writes the sub-sport, so the watch picks the right profile', () => {
    const workout = build([{ goal_s: 600 }], { sub_sport: 'treadmill' });
    expect(roundTrip(workout).workoutMesgs[0]).toMatchObject({ sport: 'running', subSport: 'treadmill' });
  });

  it('leaves both out when the workout has neither', () => {
    const mesg = roundTrip(build([{ goal_s: 600 }])).workoutMesgs[0];
    expect(mesg.wktDescription).toBeUndefined();
    expect(mesg.subSport).toBeUndefined();
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

  it('converts every distance unit into metres in the file', () => {
    const steps = roundTrip(
      build([{ goal_meters: 400 }, { goal_km: 5 }, { goal_miles: 1 }, { goal_yards: 100 }]),
    ).workoutStepMesgs;
    expect(steps[0].durationDistance).toBeCloseTo(400, 2);
    expect(steps[1].durationDistance).toBeCloseTo(5000, 2);
    expect(steps[2].durationDistance as number).toBeCloseTo(1609.34, 1);
    expect(steps[3].durationDistance as number).toBeCloseTo(91.44, 1);
  });

  it('rounds sub-centimetre distances rather than truncating to zero', () => {
    // 100 yards is 9144 centimetres exactly; a truncating encoder loses the tail.
    const step = roundTrip(build([{ goal_yards: 100 }])).workoutStepMesgs[0];
    expect(step.durationDistance).toBe(91.44);
  });
});

describe('targets', () => {
  it('writes a pace range as a speed range in m/s', () => {
    const step = roundTrip(build([{ goal_meters: 400, target_pace_km: ['4:00', '4:15'] }])).workoutStepMesgs[0];
    expect(step).toMatchObject({ targetType: 'speed', targetValue: 0 });
    expect(step.customTargetSpeedLow as number).toBeCloseTo(1000 / 255, 2);
    expect(step.customTargetSpeedHigh as number).toBeCloseTo(1000 / 240, 2);
  });

  /**
   * FIT has no "below X" target — a target is a band — so an open end is
   * filled with the extreme of the range rather than left out. The filler
   * must be in the unit the caller used: the profile packs a percentage and
   * an absolute into one field, so a raw 0 floor under a ceiling in watts is
   * two different units, which is what an importer refused.
   */
  it('fills an open end in the unit the caller used, never a raw zero', () => {
    // Asserted on the raw field: the decoder renders the offset values
    // themselves by their profile names ("wattsOffset", "bpmOffset"), which
    // says nothing about what was written.

    // 0 W is 1000 in workoutPower's watts offset, not 0 — 0 would be 0% FTP.
    const capped = roundTrip(build([{ goal_s: 60, target_watts: ['-', 120] }])).workoutStepMesgs[0];
    expect(capped).toMatchObject({ customTargetValueLow: 1000, customTargetValueHigh: 1120 });

    // 0 bpm is 100 in workoutHr's bpm offset.
    const under = roundTrip(build([{ goal_s: 60, target_heart_rate: ['-', 150] }])).workoutStepMesgs[0];
    expect(under).toMatchObject({ customTargetValueLow: 100, customTargetValueHigh: 250 });

    // A percentage stays a percentage, where a raw 0 is correct.
    const percent = roundTrip(build([{ goal_s: 60, target_watts: ['-', '80%'] }])).workoutStepMesgs[0];
    expect(percent).toMatchObject({ customTargetPowerLow: 0, customTargetPowerHigh: 80 });

    const hrPercent = roundTrip(build([{ goal_s: 60, target_heart_rate: ['70%', '-'] }])).workoutStepMesgs[0];
    expect(hrPercent).toMatchObject({ customTargetValueLow: 70, customTargetValueHigh: 100 });
  });

  it('writes both bounds even when one end is open', () => {
    // Speed and cadence have no dual encoding, so a plain zero is genuinely
    // zero there — but the field still has to be present.
    const faster = roundTrip(build([{ goal_s: 60, target_pace_km: ['6:30', '-'] }])).workoutStepMesgs[0];
    expect(faster.customTargetSpeedLow as number).toBeCloseTo(1000 / 390, 2);
    expect(faster.customTargetSpeedHigh as number).toBeCloseTo(25, 2);

    const spun = roundTrip(build([{ goal_s: 60, target_cadence: [85, '-'] }])).workoutStepMesgs[0];
    expect(spun).toMatchObject({ customTargetCadenceLow: 85, customTargetCadenceHigh: 254 });
  });

  it('fills the open end of a secondary target too', () => {
    const step = roundTrip(
      build([{ goal_s: 60, target_watts: [152, 180], target_cadence: ['-', 95] }]),
    ).workoutStepMesgs[0];
    expect(step).toMatchObject({ secondaryCustomTargetCadenceLow: 0, secondaryCustomTargetCadenceHigh: 95 });
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
    const step = roundTrip(build([{ goal_s: 60, target_hr_zone: 3 }])).workoutStepMesgs[0];
    expect(step).toMatchObject({ targetType: 'heartRate', targetHrZone: 3 });
    expect(step.customTargetValueLow).toBeUndefined();
  });

  it('maps each zone metric to its FIT target type', () => {
    const steps = roundTrip(
      build([
        { goal_s: 60, target_hr_zone: 2 },
        { goal_s: 60, target_pace_zone: 6 },
        { goal_s: 60, target_power_zone: 4 },
      ]),
    ).workoutStepMesgs;
    expect(steps[0]).toMatchObject({ targetType: 'heartRate', targetHrZone: 2 });
    // A pace zone is a speed zone as far as FIT is concerned.
    expect(steps[1]).toMatchObject({ targetType: 'speed', targetSpeedZone: 6 });
    expect(steps[2]).toMatchObject({ targetType: 'power', targetPowerZone: 4 });
  });

  it('writes a zone range as a percentage band, not a zone', () => {
    const steps = roundTrip(
      build([
        { goal_s: 60, target_hr_zone: [2, 4] },
        { goal_s: 60, target_power_zone: [4, 5] },
      ]),
    ).workoutStepMesgs;

    // 0-100 in workoutHr is a percentage of max HR, written unchanged, and
    // the zone number itself is no longer part of the step.
    expect(steps[0]).toMatchObject({
      targetType: 'heartRate',
      targetHrZone: 0,
      customTargetHeartRateLow: 60,
      customTargetHeartRateHigh: 80,
    });
    // 0-1000 in workoutPower is a percentage of FTP.
    expect(steps[1]).toMatchObject({ targetType: 'power', customTargetPowerLow: 90, customTargetPowerHigh: 105 });
  });

  it('writes a cadence range in plain rpm', () => {
    const step = roundTrip(build([{ goal_s: 60, target_cadence: [85, 95] }])).workoutStepMesgs[0];
    expect(step).toMatchObject({ targetType: 'cadence', customTargetCadenceLow: 85, customTargetCadenceHigh: 95 });
  });

  it('leaves an untargeted step open', () => {
    const step = roundTrip(build([{ goal_s: 600 }])).workoutStepMesgs[0];
    expect(step).toMatchObject({ targetType: 'open' });
    expect(step.customTargetValueLow).toBeUndefined();
  });
});

describe('a second target', () => {
  it('writes the primary and secondary under their own fields', () => {
    const step = roundTrip(
      build([{ goal_meters: 400, target_pace_km: ['4:00', '4:15'], target_cadence: [178, 184] }]),
    ).workoutStepMesgs[0];

    expect(step).toMatchObject({ targetType: 'speed', secondaryTargetType: 'cadence' });
    expect(step.customTargetSpeedLow as number).toBeCloseTo(1000 / 255, 2);
    expect(step).toMatchObject({ secondaryCustomTargetCadenceLow: 178, secondaryCustomTargetCadenceHigh: 184 });
  });

  it('writes a zone as the secondary target value, not a range', () => {
    const step = roundTrip(
      build([{ goal_s: 300, target_watts: [240, 260], target_hr_zone: 3 }]),
    ).workoutStepMesgs[0];

    expect(step).toMatchObject({ targetType: 'power', secondaryTargetType: 'heartRate', secondaryTargetHrZone: 3 });
    expect(step.secondaryCustomTargetValueLow).toBeUndefined();
  });

  it('writes no secondary fields when there is only one target', () => {
    const step = roundTrip(build([{ goal_s: 60, target_heart_rate: [140, 150] }])).workoutStepMesgs[0];
    expect(step.secondaryTargetType).toBeUndefined();
  });
});

describe('names, notes and intensity', () => {
  it('writes the step name and note the athlete will see', () => {
    const step = roundTrip(
      build([{ name: '400m rep', notes: 'Hold form, relax the shoulders', goal_meters: 400 }]),
    ).workoutStepMesgs[0];
    expect(step).toMatchObject({ wktStepName: '400m rep', notes: 'Hold form, relax the shoulders' });
  });

  it('writes every intensity FIT understands', () => {
    const intensities = ['warmup', 'active', 'interval', 'rest', 'recovery', 'cooldown'];
    const steps = roundTrip(
      build(intensities.map((intensity) => ({ goal_s: 60, intensity }))),
    ).workoutStepMesgs;
    expect(steps.map((step) => step.intensity)).toEqual(intensities);
  });

  it('omits a name rather than writing an empty one', () => {
    expect(roundTrip(build([{ goal_s: 60 }])).workoutStepMesgs[0].wktStepName).toBeUndefined();
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

  it('gives the repeat a target type, which every step is expected to have', () => {
    // The repeat has no target of its own, but a step without the field is
    // the one record an importer reading it unconditionally will fail on.
    const repeat = roundTrip(intervals).workoutStepMesgs[3];
    expect(repeat.targetType).toBe('open');
    // And it still reads as a repeat count, which resolves off durationType.
    expect(repeat.repeatSteps).toBe(8);
  });

  it('counts the repeat step in numValidSteps', () => {
    expect(roundTrip(intervals).workoutMesgs[0]).toMatchObject({ numValidSteps: 5 });
  });

  it('stores a repeat once instead of unrolling it', () => {
    const reps = (times: number) =>
      roundTrip(
        build([
          { name: 'Warmup', goal_s: 600 },
          { repeat: times, steps: [{ name: 'On', goal_s: 30 }, { name: 'Off', goal_s: 30 }] },
          { name: 'Cooldown', goal_s: 600 },
        ]),
      );

    // Warmup, On, Off, the repeat, Cooldown — whatever the rep count.
    const four = reps(4);
    const forty = reps(40);
    expect(four.workoutStepMesgs).toHaveLength(5);
    expect(forty.workoutStepMesgs).toHaveLength(5);
    expect(forty.bytes.length).toBe(four.bytes.length);
    expect(forty.workoutStepMesgs[3]).toMatchObject({ repeatSteps: 40 });
  });

  it('keeps message indices dense and in order, which repeats point into', () => {
    const decoded = roundTrip(
      build([
        { goal_s: 60 },
        { repeat: 3, steps: [{ goal_s: 30 }, { repeat: 2, steps: [{ goal_s: 10 }] }] },
        { goal_s: 60 },
      ]),
    );
    expect(decoded.workoutStepMesgs.map((step) => step.messageIndex)).toEqual([...Array(6).keys()]);
    expect(decoded.workoutMesgs[0]).toMatchObject({ numValidSteps: 6 });
  });

  it('handles nested repeats', () => {
    const nested = build([
      { repeat: 2, steps: [{ name: 'A', goal_s: 30 }, { repeat: 3, steps: [{ name: 'B', goal_s: 10 }] }] },
    ]);
    const flat = flattenSteps(resolveSteps(nested.steps));
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

describe('a whole session', () => {
  it('encodes a real interval workout end to end', () => {
    const session = build(
      [
        { name: 'Warmup', goal_s: 900, target_heart_rate: ['-', 145] },
        { name: 'Strides', repeat: 4, steps: [{ name: 'Stride', goal_s: 20, target_pace_km: ['3:30', '-'] }, { name: 'Walk', goal_s: 40, intensity: 'rest' }] },
        {
          repeat: 5,
          steps: [
            { name: '1k rep', goal_meters: 1000, target_pace_km: ['3:55', '4:05'] },
            { name: 'Jog', goal_s: 120, intensity: 'recovery', target_heart_rate: ['-', 140] },
          ],
        },
        { name: 'Cooldown', goal_s: 600, intensity: 'cooldown' },
      ],
      { name: '5x1k' },
    );

    const decoded = roundTrip(session);
    // Warmup, the strides block and its repeat, the reps block and its
    // repeat, and the cooldown: eight FIT steps for a session of 19 efforts.
    expect(decoded.workoutMesgs[0]).toMatchObject({ wktName: '5x1k', sport: 'running', numValidSteps: 8 });

    expect(decoded.workoutStepMesgs.map((step) => step.wktStepName ?? step.durationType)).toEqual([
      'Warmup',
      'Stride',
      'Walk',
      'repeatUntilStepsCmplt',
      '1k rep',
      'Jog',
      'repeatUntilStepsCmplt',
      'Cooldown',
    ]);

    // The two repeats point at their own first child, not each other's.
    const repeats = decoded.workoutStepMesgs.filter((step) => step.durationType === 'repeatUntilStepsCmplt');
    expect(repeats).toHaveLength(2);
    expect(repeats[0]).toMatchObject({ durationStep: 1, repeatSteps: 4 });
    expect(repeats[1]).toMatchObject({ durationStep: 4, repeatSteps: 5 });
  });
});
