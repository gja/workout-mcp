// A recorded session as a FIT activity file, built the way a watch writes one, so the
// stats can be asserted against numbers the test chose. See docs/testing.md.

import { Profile } from '@garmin/fitsdk';
import { createEncoder, write } from '../src/fit';

export type LapSpec = {
  seconds: number;
  /** Metres per second held for the lap, or absent for a lap that records no speed. */
  speed?: number;
  /** Heart rate at the start and at the end of the lap, walked between the two. */
  hr?: [number, number];
  /** A steady effort, or several values cycled sample by sample to make it a variable one. */
  power?: number | number[];
  /** Crank or stride rate, as FIT counts it: one leg per cycle. */
  cadence?: number;
  trigger?: string;
  intensity?: string;
};

export type ActivitySpec = {
  sport?: string;
  /** Written onto the session message, for the file that already says what its power was. */
  normalizedPower?: number;
  subSport?: string;
  /** Whether records carry a position, which is the whole of what makes a session outdoor. */
  outdoor?: boolean;
  /** Seconds between records. Above one is smart recording, as a watch saving battery does it. */
  interval?: number;
  startTime?: Date;
  laps: LapSpec[];
};

const average = (values: number[]): number | undefined =>
  values.length === 0 ? undefined : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);

const defined = <T extends object>(fields: T): T =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;

/** `Math.round` on the way in, so a decoded reading is the one the spec asked for. */
const walk = (lap: LapSpec, second: number): number | undefined => {
  if (!lap.hr) return undefined;
  const [from, to] = lap.hr;
  return Math.round(from + ((to - from) * second) / Math.max(1, lap.seconds - 1));
};

export function encodeActivityFit(spec: ActivitySpec): Uint8Array {
  const encoder = createEncoder();
  const start = spec.startTime ?? new Date('2026-09-07T06:00:00Z');
  const sport = spec.sport ?? 'running';

  write(encoder, Profile.MesgNum.FILE_ID, {
    type: 'activity',
    manufacturer: 'development',
    product: 0,
    serialNumber: 1,
    timeCreated: start,
  });

  let elapsed = 0;
  let distance = 0;
  const hrs: number[] = [];
  const powers: number[] = [];
  const cadences: number[] = [];
  const lapMesgs: Array<Record<string, unknown>> = [];

  for (const lap of spec.laps) {
    const lapStart = elapsed;
    const lapHrs: number[] = [];
    const lapDistance = (lap.speed ?? 0) * lap.seconds;

    const interval = spec.interval ?? 1;
    const lapPowers: number[] = [];
    for (let second = 0; second < lap.seconds; second += interval) {
      const power = Array.isArray(lap.power) ? lap.power[lapPowers.length % lap.power.length] : lap.power;
      if (power !== undefined) lapPowers.push(power);
      const hr = walk(lap, second);
      if (hr !== undefined) lapHrs.push(hr);
      if (lap.speed !== undefined) distance += lap.speed * interval;

      write(
        encoder,
        Profile.MesgNum.RECORD,
        defined({
          timestamp: new Date(start.getTime() + (elapsed + second) * 1000),
          heartRate: hr,
          cadence: lap.cadence,
          power,
          enhancedSpeed: lap.speed,
          distance: lap.speed === undefined ? undefined : distance,
          // Semicircles. Any fixed point will do: only its presence is read.
          positionLat: spec.outdoor === false ? undefined : 152_000_000,
          positionLong: spec.outdoor === false ? undefined : 900_000_000,
        }),
      );
    }

    hrs.push(...lapHrs);
    powers.push(...lapPowers);
    if (lap.cadence !== undefined) cadences.push(...Array<number>(lapHrs.length || 1).fill(lap.cadence));
    elapsed += lap.seconds;

    lapMesgs.push(
      defined({
        messageIndex: lapMesgs.length,
        timestamp: new Date(start.getTime() + elapsed * 1000),
        startTime: new Date(start.getTime() + lapStart * 1000),
        event: 'lap',
        eventType: 'stop',
        sport,
        totalElapsedTime: lap.seconds,
        totalTimerTime: lap.seconds,
        totalDistance: lap.speed === undefined ? undefined : lapDistance,
        avgSpeed: lap.speed,
        avgHeartRate: average(lapHrs),
        maxHeartRate: lapHrs.length === 0 ? undefined : Math.max(...lapHrs),
        minHeartRate: lapHrs.length === 0 ? undefined : Math.min(...lapHrs),
        avgCadence: lap.cadence,
        // The averages only. A file built out of streams carries no more than that,
        // which is the whole reason the reader computes the rest.
        avgPower: average(lapPowers),
        lapTrigger: lap.trigger ?? 'manual',
        intensity: lap.intensity ?? 'active',
      }),
    );
  }

  for (const lap of lapMesgs) write(encoder, Profile.MesgNum.LAP, lap);

  write(
    encoder,
    Profile.MesgNum.SESSION,
    defined({
      messageIndex: 0,
      timestamp: new Date(start.getTime() + elapsed * 1000),
      startTime: start,
      event: 'session',
      eventType: 'stop',
      sport,
      subSport: spec.subSport ?? 'generic',
      totalElapsedTime: elapsed,
      totalTimerTime: elapsed,
      totalDistance: distance || undefined,
      avgSpeed: distance === 0 ? undefined : distance / elapsed,
      avgHeartRate: average(hrs),
      maxHeartRate: hrs.length === 0 ? undefined : Math.max(...hrs),
      minHeartRate: hrs.length === 0 ? undefined : Math.min(...hrs),
      avgCadence: average(cadences),
      avgPower: average(powers),
      normalizedPower: spec.normalizedPower,
      numLaps: lapMesgs.length,
      firstLapIndex: 0,
    }),
  );

  write(encoder, Profile.MesgNum.ACTIVITY, {
    timestamp: new Date(start.getTime() + elapsed * 1000),
    totalTimerTime: elapsed,
    numSessions: 1,
    type: 'manual',
    event: 'activity',
    eventType: 'stop',
  });

  return encoder.close();
}
