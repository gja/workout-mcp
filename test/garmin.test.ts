import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteWorkout, getWorkout, putWorkout, setCompleted } from '../src/db';
import { buildWorkout } from '../src/garmin/payload';
import type { GarminExecutableStep, GarminRepeatStep } from '../src/garmin/payload';
import { fingerprint, keyId, seal, unseal } from '../src/garmin/crypto';
import { challengeFor, randomVerifier } from '../src/garmin/oauth';
import * as store from '../src/garmin/store';
import { MAX_SYNC_PASSES, planFor, syncAll } from '../src/garmin/sync';
import { SyncBusyError, newBudget, syncEveryone } from '../src/sync';
import { localDateOf, matchCompletions, sportOf, uploadWindows } from '../src/garmin/activities';
import type { GarminActivity } from '../src/garmin/activities';
import { shiftDate, today } from '../src/units';
import { parseWorkout } from '../src/workout';
import type { Workout } from '../src/workout';
import { issueToken } from '../src/auth';
import { resetDatabase, seedUser, sessionCookieFor } from './helpers';

const BASE = 'https://workouts.example';

let userId: string;
let token: string;

/** What the stand-in Garmin recorded, over the service binding. */
type StubState = {
  workouts: Array<{ id: string; payload: Record<string, unknown> }>;
  schedules: Array<{ id: string; workoutId: string; date: string }>;
  calls: Array<{ what: string; body?: unknown; grant?: string }>;
  issued: string[];
};

const stub = {
  reset: () => env.GARMIN_STUB.fetch('https://stub/__stub/reset', { method: 'POST' }),
  state: async (): Promise<StubState> =>
    (await env.GARMIN_STUB.fetch('https://stub/__stub/state').then((r) => r.json())) as StubState,
  fail: (knobs: Record<string, unknown>) =>
    env.GARMIN_STUB.fetch('https://stub/__stub/fail', { method: 'POST', body: JSON.stringify(knobs) }),
  /** As if the athlete had deleted everything in the Garmin Connect app. */
  forget: () => env.GARMIN_STUB.fetch('https://stub/__stub/forget', { method: 'POST' }),
  /** What the athlete recorded, for the completion pull to find. */
  activities: (activities: unknown[]) =>
    env.GARMIN_STUB.fetch('https://stub/__stub/activities', { method: 'POST', body: JSON.stringify(activities) }),
};

/** An activity summary as the Activity API reports one. */
const activity = (over: Partial<GarminActivity> & { hoursAgo?: number } = {}): GarminActivity => {
  const { hoursAgo = 2, ...rest } = over;
  return {
    activityId: 555,
    activityName: 'Morning Run',
    activityType: 'RUNNING',
    startTimeInSeconds: Math.floor(Date.now() / 1000) - hoursAgo * 3600,
    startTimeOffsetInSeconds: 0,
    durationInSeconds: 2820,
    distanceInMeters: 8000,
    ...rest,
  };
};

/** Just the calls that would change the athlete's calendar. */
const training = (state: StubState) => state.calls.filter((entry) => entry.what?.includes('training-api'));

/**
 * Wait for the push a write scheduled.
 *
 * A write returns before its Garmin push runs — that is the point of doing it
 * in `waitUntil`, and it is what keeps a Garmin outage from failing a write —
 * so a test that asserts the push happened has to wait for it rather than
 * assume the response meant it was done.
 */
const eventually = (check: (state: StubState) => void): Promise<void> =>
  vi.waitFor(async () => check(await stub.state()), { timeout: 5_000, interval: 25 });

beforeEach(async () => {
  await resetDatabase();
  await stub.reset();
  ({ id: userId, token } = await seedUser());
});

const call = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });

const DAY = shiftDate(today(), 2);
const OTHER_DAY = shiftDate(today(), 5);

const INTERVALS = {
  date: DAY,
  name: '8x400m',
  notes: 'Track session',
  sub_sport: 'track',
  steps: [
    { name: 'Warmup', goal_s: 600, target_heart_rate: [146, 153] },
    {
      repeat: 8,
      steps: [
        { name: 'Fast', goal_meters: 400, target_pace_km: ['4:00', '4:15'], target_cadence: [180, 190] },
        { name: 'Float', goal_s: 90, target_pace_km: ['-', '6:30'] },
      ],
    },
    { name: 'Cooldown', goal_s: 600 },
  ],
};

/** A stored workout, written straight to D1 rather than over the API. */
const store_workout = (input: Record<string, unknown> = INTERVALS): Promise<Workout> =>
  putWorkout(env, userId, parseWorkout(input));

/**
 * One parameter off a redirect the app issued.
 *
 * Read through `URL` rather than by decoding the string: the query is
 * form-encoded, so a space arrives as `+`, which `decodeURIComponent` leaves
 * exactly where it is.
 */
const redirectParam = (response: Response, name: string): string | null =>
  new URL(response.headers.get('Location')!).searchParams.get(name);

/**
 * Connect a Garmin account by driving the real flow: `/garmin/connect` hands
 * out the state, and the callback is answered as Garmin would answer it.
 */
async function connectGarmin(cookie?: string): Promise<string> {
  const session = cookie ?? (await sessionCookieFor());
  const started = await SELF.fetch(`${BASE}/garmin/connect`, { headers: { Cookie: session }, redirect: 'manual' });
  expect(started.status).toBe(302);

  const consent = new URL(started.headers.get('Location')!);
  expect(consent.origin + consent.pathname).toBe('https://connect.garmin.com/oauth2Confirm');
  const state = consent.searchParams.get('state')!;

  const back = await SELF.fetch(`${BASE}/garmin/callback?code=granted&state=${state}`, {
    headers: { Cookie: session },
    redirect: 'manual',
  });
  expect(back.status).toBe(302);
  expect(back.headers.get('Location')).toContain('garmin_connected=1');
  return session;
}

// ---------------------------------------------------------------------------

describe('sealing tokens', () => {
  it('round-trips a token and hides it in the stored form', async () => {
    const sealed = await seal('secret', 'garmin-access-token');
    expect(sealed).not.toContain('garmin-access-token');
    expect(await unseal('secret', sealed)).toBe('garmin-access-token');
  });

  it('gives a different ciphertext each time, so two rows do not match', async () => {
    expect(await seal('secret', 'same')).not.toBe(await seal('secret', 'same'));
  });

  it('refuses to open with the wrong key rather than returning nonsense', async () => {
    expect(await unseal('other-secret', await seal('secret', 'token'))).toBeNull();
    expect(await unseal('secret', 'not-even-base64-$$$')).toBeNull();
  });

  it('names the key without revealing it', async () => {
    const id = await keyId('secret');
    expect(id).toBe(await keyId('secret'));
    expect(id).not.toBe(await keyId('other'));
    expect(id).not.toContain('secret');
  });

  it('fingerprints by value, not by key order', async () => {
    expect(await fingerprint({ a: 1, b: 2 })).toBe(await fingerprint({ a: 1, b: 2 }));
    expect(await fingerprint({ a: 1 })).not.toBe(await fingerprint({ a: 2 }));
  });
});

describe('the PKCE challenge', () => {
  it('is the base64url SHA-256 of the verifier, with no padding', async () => {
    const challenge = await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('gives a fresh verifier each time', () => {
    expect(randomVerifier()).not.toBe(randomVerifier());
  });
});

describe('building the Garmin payload', () => {
  it('nests repeats and numbers every step once, across the whole workout', async () => {
    const { workout } = buildWorkout(await store_workout());

    expect(workout.sport).toBe('RUNNING');
    expect(workout.subSport).toBe('TRACK');
    expect(workout.description).toBe('Track session');
    expect(workout.workoutProvider).toBe('workout-mcp');
    expect(workout.segments).toHaveLength(1);

    const steps = workout.segments[0].steps;
    expect(steps.map((step) => step.type)).toEqual(['WorkoutStep', 'WorkoutRepeatStep', 'WorkoutStep']);

    const repeat = steps[1] as GarminRepeatStep;
    expect(repeat.repeatType).toBe('REPEAT_UNTIL_STEPS_CMPLT');
    expect(repeat.repeatValue).toBe(8);
    expect(repeat.steps).toHaveLength(2);

    // One counter for the tree: the repeat takes 2, its children 3 and 4, and
    // the cooldown carries on at 5 rather than restarting.
    expect(steps.map((step) => step.stepOrder)).toEqual([1, 2, 5]);
    expect(repeat.steps.map((step) => step.stepOrder)).toEqual([3, 4]);
  });

  it('carries durations and both ends of a target across', async () => {
    const { workout } = buildWorkout(await store_workout());
    const steps = workout.segments[0].steps;

    const warmup = steps[0] as GarminExecutableStep;
    expect(warmup.intensity).toBe('WARMUP');
    expect(warmup.durationType).toBe('TIME');
    expect(warmup.durationValue).toBe(600);
    expect(warmup.targetType).toBe('HEART_RATE');
    expect(warmup.targetValueLow).toBe(146);
    expect(warmup.targetValueHigh).toBe(153);

    const fast = (steps[1] as GarminRepeatStep).steps[0] as GarminExecutableStep;
    expect(fast.durationType).toBe('DISTANCE');
    expect(fast.durationValue).toBe(400);
    // 400 m in 4:00 is 4.167 m/s; the faster end of the band is the higher speed.
    expect(fast.targetType).toBe('PACE');
    expect(fast.targetValueLow).toBeCloseTo(1000 / 255, 3);
    expect(fast.targetValueHigh).toBeCloseTo(1000 / 240, 3);
  });

  it('folds a name, a note and a dropped second target into the description', async () => {
    const { workout, notes } = buildWorkout(await store_workout());
    const fast = (workout.segments[0].steps[1] as GarminRepeatStep).steps[0] as GarminExecutableStep;

    // Pace leads, so cadence is the secondary — and Garmin holds one target.
    expect(fast.description).toContain('Fast');
    expect(fast.description).toContain('180-190 rpm');
    expect(notes.join('\n')).toContain('one target per step');
  });

  it('widens an open-ended range to the metric limit, and says so', async () => {
    const { workout, notes } = buildWorkout(await store_workout());
    const float = (workout.segments[0].steps[1] as GarminRepeatStep).steps[1] as GarminExecutableStep;

    // "slower than 6:30" is a ceiling on speed with no floor, so the floor
    // becomes the slowest speed the mapping allows rather than an invention.
    expect(float.targetValueLow).toBe(0.1);
    expect(float.targetValueHigh).toBeCloseTo(1000 / 390, 3);
    expect(notes.join('\n')).toContain('widened');
  });

  it('reports totals only when the plan adds up to something', async () => {
    const { workout } = buildWorkout(await store_workout());
    expect(workout.estimatedDurationInSecs).toBe(600 + 8 * 90 + 600);
    expect(workout.estimatedDistanceInMeters).toBe(8 * 400);

    const open = buildWorkout(await store_workout({ date: OTHER_DAY, name: 'Open', steps: [{ name: 'Run' }] }));
    expect(open.workout.estimatedDurationInSecs).toBeUndefined();
    expect(open.workout.estimatedDistanceInMeters).toBeUndefined();
    expect((open.workout.segments[0].steps[0] as GarminExecutableStep).durationType).toBe('OPEN');
  });

  it('turns a percentage target into a percentage, not a bpm count', async () => {
    const { workout } = buildWorkout(
      await store_workout({ date: DAY, name: 'Percent', steps: [{ goal_s: 600, target_heart_rate: ['70%', '80%'] }] }),
    );
    const step = workout.segments[0].steps[0] as GarminExecutableStep;
    expect(step.targetValueType).toBe('PERCENT_MAX_HEART_RATE');
    expect(step.targetValueLow).toBe(70);
    expect(step.targetValueHigh).toBe(80);
  });

  it('does not invert an open-ended power band above 100% of FTP', async () => {
    // 110% of FTP is an ordinary interval, and a shared percent ceiling of
    // 100 used to turn "at least 110%" into a band from 110 down to 100.
    const { workout } = buildWorkout(
      await store_workout({ date: DAY, name: 'Over FTP', steps: [{ goal_s: 300, target_watts: ['110%', '-'] }] }),
    );
    const step = workout.segments[0].steps[0] as GarminExecutableStep;
    expect(step.targetValueType).toBe('PERCENT_FTP');
    expect(step.targetValueLow).toBe(110);
    expect(step.targetValueHigh).toBe(1000);
    expect(step.targetValueLow!).toBeLessThanOrEqual(step.targetValueHigh!);
  });

  it('keeps a percentage heart-rate band inside 100', async () => {
    const { workout } = buildWorkout(
      await store_workout({ date: DAY, name: 'Percent HR', steps: [{ goal_s: 300, target_heart_rate: ['80%', '-'] }] }),
    );
    const step = workout.segments[0].steps[0] as GarminExecutableStep;
    expect(step.targetValueLow).toBe(80);
    expect(step.targetValueHigh).toBe(100);
  });

  it('sends a single zone as a zone, for the watch to resolve', async () => {
    const { workout } = buildWorkout(
      await store_workout({ date: DAY, name: 'Zone', steps: [{ goal_s: 600, target_hr_zone: 3 }] }),
    );
    const step = workout.segments[0].steps[0] as GarminExecutableStep;
    expect(step.targetType).toBe('HEART_RATE_ZONE');
    expect(step.targetValue).toBe(3);
  });

  it('leaves off a sub-sport Garmin has no name for, rather than guessing', async () => {
    const { workout, notes } = buildWorkout(
      await store_workout({ date: DAY, name: 'Ultra', sub_sport: 'ultra', steps: [{ goal_km: 50 }] }),
    );
    expect(workout.subSport).toBeUndefined();
    expect(notes.join('\n')).toContain('no equivalent');
  });

  it('is pure, so the same workout builds the same payload twice', async () => {
    const workout = await store_workout();
    expect(await fingerprint(buildWorkout(workout).workout)).toBe(await fingerprint(buildWorkout(workout).workout));
  });
});

describe('reading activities back', () => {
  it('places an activity on the local day the athlete would name, not on UTC', () => {
    // 06:30 in Auckland (UTC+12) is the previous day in UTC, and the athlete
    // would say they ran on the 12th.
    const morning = Date.parse('2026-09-11T18:30:00Z') / 1000;
    expect(localDateOf({ startTimeInSeconds: morning, startTimeOffsetInSeconds: 12 * 3600 })).toBe('2026-09-12');
    expect(localDateOf({ startTimeInSeconds: morning, startTimeOffsetInSeconds: 0 })).toBe('2026-09-11');
  });

  it('skips an activity it cannot place', () => {
    expect(localDateOf({})).toBeNull();
  });

  it('recognises a sport by family rather than by an exhaustive list', () => {
    expect(sportOf('RUNNING')).toBe('running');
    expect(sportOf('TRAIL_RUNNING')).toBe('running');
    expect(sportOf('VIRTUAL_RUN')).toBe('running');
    expect(sportOf('GRAVEL_CYCLING')).toBe('cycling');
    expect(sportOf('MOUNTAIN_BIKING')).toBe('cycling');
    expect(sportOf('OPEN_WATER_SWIMMING')).toBe('swimming');
    expect(sportOf('INDOOR_ROWING')).toBe('rowing');
    expect(sportOf('STRENGTH_TRAINING')).toBe('training');
    expect(sportOf('MOUNTAINEERING')).toBe('hiking');
    expect(sportOf('SPEED_WALKING')).toBe('walking');
    expect(sportOf('SOMETHING_NEW')).toBeNull();
    expect(sportOf(undefined)).toBeNull();
  });

  it('asks for one day of upload time at a time, newest first', () => {
    const windows = uploadWindows(new Date('2026-09-12T00:00:00Z'), 3);
    expect(windows).toHaveLength(3);
    expect(windows[0][1] - windows[0][0]).toBe(86400);
    // Contiguous, so nothing between two slices is missed.
    expect(windows[1][1]).toBe(windows[0][0]);
    expect(windows[2][1]).toBe(windows[1][0]);
  });

  const planned = (over: Partial<Workout> = {}): Workout =>
    ({
      id: 'w1',
      date: DAY,
      name: 'Easy run',
      sport: 'running',
      steps: [{ goal_s: 2700 }],
      updated_at: 'now',
      ...over,
    }) as Workout;

  it('matches a same-day activity of the same sport', () => {
    const matches = matchCompletions([planned()], [activity({ hoursAgo: 0, startTimeOffsetInSeconds: 0 })]);
    expect(matches).toHaveLength(0); // today, not DAY

    const onTheDay = activity({ startTimeInSeconds: Date.parse(`${DAY}T06:30:00Z`) / 1000 });
    expect(matchCompletions([planned()], [onTheDay])).toHaveLength(1);
  });

  it('leaves an already-completed workout alone', () => {
    const onTheDay = activity({ startTimeInSeconds: Date.parse(`${DAY}T06:30:00Z`) / 1000 });
    expect(matchCompletions([planned({ completed_at: 'yesterday' })], [onTheDay])).toHaveLength(0);
  });

  it('will not tick off a run with a swim', () => {
    const swim = activity({ activityType: 'LAP_SWIMMING', startTimeInSeconds: Date.parse(`${DAY}T06:30:00Z`) / 1000 });
    expect(matchCompletions([planned()], [swim])).toHaveLength(0);
    // A generic plan is the one that accepts anything, because that is what
    // generic means.
    expect(matchCompletions([planned({ sport: 'generic' })], [swim])).toHaveLength(1);
  });

  it('spends each activity once, so two sessions need two activities', () => {
    const start = Date.parse(`${DAY}T06:30:00Z`) / 1000;
    const one = activity({ activityId: 1, startTimeInSeconds: start });
    const matches = matchCompletions([planned({ id: 'a' }), planned({ id: 'b' })], [one]);
    expect(matches).toHaveLength(1);
    expect(matches[0].workout.id).toBe('a');
  });

  it('pairs two same-day sessions by how long each was planned to be', () => {
    const start = Date.parse(`${DAY}T06:30:00Z`) / 1000;
    const short = activity({ activityId: 1, durationInSeconds: 1200, startTimeInSeconds: start });
    const long = activity({ activityId: 2, durationInSeconds: 5400, startTimeInSeconds: start + 7200 });

    // Listed long-first, so order alone cannot be what pairs them correctly.
    const matches = matchCompletions(
      [planned({ id: 'intervals', steps: [{ goal_s: 1200 }] }), planned({ id: 'long', steps: [{ goal_s: 5400 }] })],
      [long, short],
    );
    expect(matches.map((m) => [m.workout.id, m.activity.activityId])).toEqual([
      ['intervals', 1],
      ['long', 2],
    ]);
  });

  it('records the start of the activity as the completion time', () => {
    const start = Date.parse(`${DAY}T06:30:00Z`) / 1000;
    const [match] = matchCompletions([planned()], [activity({ startTimeInSeconds: start })]);
    expect(match.completedAt).toBe(new Date(start * 1000).toISOString());
  });
});

describe('the sync plan', () => {
  const link = (over: Partial<store.Link> = {}): store.Link => ({
    workoutId: 'w1',
    garminWorkoutId: '9000',
    garminScheduleId: '9001',
    scheduledDate: DAY,
    fingerprint: 'fp',
    syncedAt: 'now',
    ...over,
  });
  const workout = { id: 'w1', date: DAY } as Workout;

  it('creates when nothing has been pushed', () => {
    expect(planFor(workout, undefined, 'fp', false).do).toBe('create');
  });

  it('does nothing when the payload and the date both still match', () => {
    expect(planFor(workout, link(), 'fp', false).do).toBe('nothing');
  });

  it('updates a changed payload in place', () => {
    expect(planFor(workout, link(), 'different', false).do).toBe('update');
  });

  it('reschedules a workout that moved day, without touching its content', () => {
    expect(planFor({ ...workout, date: OTHER_DAY }, link(), 'fp', false).do).toBe('reschedule');
  });

  it('does both when a workout changed and moved', () => {
    expect(planFor({ ...workout, date: OTHER_DAY }, link(), 'new', false).do).toBe('update-and-reschedule');
  });

  it('finishes a link whose scheduling failed, rather than creating a second copy', () => {
    // The distinguishing case: the workout is on Garmin but on no date.
    expect(planFor(workout, link({ garminScheduleId: null }), 'fp', false).do).toBe('reschedule');
  });

  it('pushes everything again when forced', () => {
    expect(planFor(workout, link(), 'fp', true).do).toBe('update');
  });
});

describe('connecting an account', () => {
  it('stores a working connection with Garmin sealed tokens', async () => {
    await connectGarmin();

    const connection = await store.getConnection(env, (await currentUserId())!);
    expect(connection?.garminUserId).toBe('garmin-athlete-1');
    expect(connection?.accessToken).toBe('garmin-access-1');
    expect(connection?.autoSync).toBe(true);

    // Nothing readable is on disk: the row holds ciphertext, not the token.
    const row = await env.DB.prepare('SELECT access_token, key_id FROM garmin_connections')
      .first<{ access_token: string; key_id: string }>();
    expect(row?.access_token).not.toContain('garmin-access');
  });

  it('sends PKCE and asks for a code', async () => {
    const session = await sessionCookieFor();
    const started = await SELF.fetch(`${BASE}/garmin/connect`, { headers: { Cookie: session }, redirect: 'manual' });
    const consent = new URL(started.headers.get('Location')!);

    expect(consent.searchParams.get('response_type')).toBe('code');
    expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
    expect(consent.searchParams.get('code_challenge')).toBeTruthy();
    expect(consent.searchParams.get('client_id')).toBe('test-garmin-client');
    expect(consent.searchParams.get('redirect_uri')).toBe(`${BASE}/garmin/callback`);
  });

  it('spends the state, so a callback cannot be replayed', async () => {
    const session = await sessionCookieFor();
    const started = await SELF.fetch(`${BASE}/garmin/connect`, { headers: { Cookie: session }, redirect: 'manual' });
    const state = new URL(started.headers.get('Location')!).searchParams.get('state')!;
    const path = `${BASE}/garmin/callback?code=granted&state=${state}`;

    const first = await SELF.fetch(path, { headers: { Cookie: session }, redirect: 'manual' });
    expect(first.headers.get('Location')).toContain('garmin_connected=1');

    const again = await SELF.fetch(path, { headers: { Cookie: session }, redirect: 'manual' });
    expect(again.headers.get('Location')).toContain('garmin_error');
  });

  it('refuses a state this account did not start', async () => {
    const mine = await sessionCookieFor();
    const started = await SELF.fetch(`${BASE}/garmin/connect`, { headers: { Cookie: mine }, redirect: 'manual' });
    const state = new URL(started.headers.get('Location')!).searchParams.get('state')!;

    // A second athlete, finishing the first one's flow.
    const theirs = await sessionCookieFor('apple');
    const back = await SELF.fetch(`${BASE}/garmin/callback?code=granted&state=${state}`, {
      headers: { Cookie: theirs },
      redirect: 'manual',
    });
    expect(redirectParam(back, 'garmin_error')).toContain('started by a different account');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM garmin_connections').first<{ n: number }>()).toMatchObject({
      n: 0,
    });
  });

  it('reports a refused code instead of failing silently', async () => {
    const session = await sessionCookieFor();
    const started = await SELF.fetch(`${BASE}/garmin/connect`, { headers: { Cookie: session }, redirect: 'manual' });
    const state = new URL(started.headers.get('Location')!).searchParams.get('state')!;

    const back = await SELF.fetch(`${BASE}/garmin/callback?code=denied&state=${state}`, {
      headers: { Cookie: session },
      redirect: 'manual',
    });
    expect(redirectParam(back, 'garmin_error')).toContain('the code was rejected');
  });

  it('sends someone who is not signed in to sign in, not to a JSON error', async () => {
    const response = await SELF.fetch(`${BASE}/garmin/connect`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(redirectParam(response, 'error')).toContain('please sign in');
  });

  it('reports an unlinked platform rather than failing the sync', async () => {
    // A sync covers every platform, so one of them being unlinked is a state
    // to report per provider, not an error for the whole call.
    const response = await call('/api/sync', { method: 'POST', body: '{}' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      providers: [{ provider: 'garmin', connected: false, connect_url: `${BASE}/garmin/connect` }],
    });
  });
});

/** An API token for one athlete, so the MCP transport can act as them. */
async function tokenFor(athlete: string): Promise<string> {
  const { token: issued } = await issueToken(env, athlete, 'test');
  return issued;
}

/** The id of the athlete the session cookie belongs to, as Google signed them in. */
async function currentUserId(): Promise<string | null> {
  const row = await env.DB.prepare("SELECT id FROM users WHERE provider = 'google'").first<{ id: string }>();
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------

describe('syncing to the calendar', () => {
  let cookie: string;
  let athlete: string;

  /**
   * Sync over the provider-neutral endpoint, and read Garmin's half of it.
   *
   * `/api/sync` covers every platform the athlete has linked, so its result is
   * a list of outcomes; these tests are about what Garmin was told.
   */
  const sync = async (body: Record<string, unknown> = {}) => {
    const response = await SELF.fetch(`${BASE}/api/sync`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as {
      providers: Array<{ provider: string; connected: boolean; report?: Awaited<ReturnType<typeof syncAll>> }>;
    };
    const garmin = outcome.providers.find((entry) => entry.provider === 'garmin');
    if (!garmin?.connected || !garmin.report) throw new Error(`garmin was not synced: ${JSON.stringify(garmin)}`);
    return garmin.report;
  };

  /**
   * A workout in place, written straight to D1.
   *
   * Not through the API on purpose: a write there pushes to Garmin on its own
   * now, which is the right behaviour and the wrong thing for these tests —
   * they are about what a sync decides, so they need to be the ones deciding
   * when one happens. `pushing after a write` below covers the other path.
   */
  const write = (input: Record<string, unknown> = INTERVALS) => putWorkout(env, athlete, parseWorkout(input));

  /** Replace a workout in place, same reasoning. */
  const rewrite = (id: string, input: Record<string, unknown>) => putWorkout(env, athlete, parseWorkout(input), id);

  beforeEach(async () => {
    cookie = await connectGarmin();
    athlete = (await currentUserId())!;
  });

  it('creates the workout and then puts it on the date', async () => {
    await write(INTERVALS);
    const report = await sync();

    expect(report.counts.created).toBe(1);
    expect(report.error).toBeUndefined();

    const state = await stub.state();
    expect(state.workouts).toHaveLength(1);
    expect(state.schedules).toHaveLength(1);
    expect(state.schedules[0]).toMatchObject({ workoutId: state.workouts[0].id, date: DAY });
    expect(state.workouts[0].payload.workoutName).toBe('8x400m');

    // The workout is created before it is scheduled, and never the other way:
    // there is nothing to schedule until it exists.
    expect(training(state).map((c) => c.what)).toEqual([
      'POST /training-api/workout',
      'POST /training-api/schedule',
    ]);
  });

  it('costs nothing the second time', async () => {
    await write(INTERVALS);
    await sync();
    const before = (await stub.state()).calls.length;

    const report = await sync();
    expect(report.counts.unchanged).toBe(1);
    expect(report.counts.created).toBe(0);
    expect((await stub.state()).calls).toHaveLength(before);
  });

  it('updates in place when the workout changes, keeping the calendar entry', async () => {
    const created = await write(INTERVALS);
    await sync();
    const before = await stub.state();

    await rewrite(created.id, { ...INTERVALS, name: '10x400m' });

    const report = await sync();
    expect(report.counts.updated).toBe(1);

    const after = await stub.state();
    expect(after.workouts).toHaveLength(1);
    expect(after.workouts[0].id).toBe(before.workouts[0].id);
    expect(after.workouts[0].payload.workoutName).toBe('10x400m');
    // The date did not move, so the calendar entry is untouched.
    expect(after.schedules[0].id).toBe(before.schedules[0].id);
  });

  it('moves the calendar entry when a workout changes day, leaving no duplicate', async () => {
    const created = await write(INTERVALS);
    await sync();
    const before = await stub.state();

    // Moved day, keeping its id, which is what `update_workout` does.
    await deleteWorkout(env, athlete, created.date, created.id);
    await rewrite(created.id, { ...INTERVALS, date: OTHER_DAY });

    const report = await sync();
    expect(report.counts.rescheduled).toBe(1);

    const after = await stub.state();
    // One entry, on the new date — the old one was removed rather than left.
    expect(after.schedules).toHaveLength(1);
    expect(after.schedules[0].date).toBe(OTHER_DAY);
    expect(after.schedules[0].id).not.toBe(before.schedules[0].id);
    // And the same underlying workout, not a second copy of it.
    expect(after.workouts).toHaveLength(1);
    expect(after.workouts[0].id).toBe(before.workouts[0].id);
  });

  it('takes a deleted workout off the calendar', async () => {
    const created = await write(INTERVALS);
    await sync();

    await deleteWorkout(env, athlete, created.date, created.id);

    const report = await sync();
    expect(report.counts.removed).toBe(1);

    const state = await stub.state();
    expect(state.schedules).toHaveLength(0);
    expect(state.workouts).toHaveLength(0);
    expect(await store.listLinks(env, athlete)).toHaveLength(0);
  });

  it('leaves training that has merely aged out on the calendar', async () => {
    // A link on a date behind the retention window: the workout is gone from
    // here because the sweep took it, not because the athlete deleted it.
    await store.saveLink(env, athlete, {
      workoutId: 'oldone',
      garminWorkoutId: '4242',
      garminScheduleId: '4243',
      scheduledDate: shiftDate(today(), -60),
      fingerprint: 'whatever',
    });

    const report = await sync();
    expect(report.counts.untracked).toBe(1);
    expect(report.counts.removed).toBe(0);

    // Nothing was deleted on Garmin — only our own tracking row went.
    const state = await stub.state();
    expect(state.calls.filter((c) => c.what?.startsWith('DELETE'))).toHaveLength(0);
    expect(await store.listLinks(env, athlete)).toHaveLength(0);
  });

  it('re-sends everything when forced', async () => {
    await write(INTERVALS);
    await sync();

    const report = await sync({ force: true });
    expect(report.counts.updated).toBe(1);
    expect(report.counts.unchanged).toBe(0);
  });

  it('changes nothing on a dry run, and shows what it would send', async () => {
    await write(INTERVALS);
    const report = await sync({ dry_run: true });

    expect(report.dry_run).toBe(true);
    expect(report.counts.created).toBe(1);
    // Counted against the Training API alone: connecting already spent a
    // token call, and a dry run is defined by touching the calendar not at all.
    expect(training(await stub.state())).toHaveLength(0);
    expect(await store.listLinks(env, athlete)).toHaveLength(0);

    // A real sync afterwards still has the work to do.
    expect((await sync()).counts.created).toBe(1);
  });

  it('reports one refused workout without abandoning the rest', async () => {
    await stub.fail({ rejectNamed: 'Doomed' });
    await write(INTERVALS);
    await write({ ...INTERVALS, date: OTHER_DAY, name: 'Doomed session' });

    const report = await sync();
    expect(report.counts.created).toBe(1);
    expect(report.counts.failed).toBe(1);

    // Garmin's own words are in the report, which is what says which field is wrong.
    const failure = report.workouts.find((entry) => entry.action === 'failed');
    expect(failure?.error).toContain('unsupported step configuration');
    expect(failure?.error).toContain('400');

    // And the failure is remembered, so the dashboard can say so.
    const status = await store.getConnection(env, athlete);
    expect(status?.lastSyncError).toContain('could not be synced');
  });

  it('finishes a half-created workout next time instead of duplicating it', async () => {
    await stub.fail({ failSchedule: true });
    await write(INTERVALS);

    const first = await sync();
    expect(first.counts.failed).toBe(1);

    // The workout is on Garmin but on no date, and that is written down.
    const mid = await stub.state();
    expect(mid.workouts).toHaveLength(1);
    expect(mid.schedules).toHaveLength(0);
    expect((await store.listLinks(env, athlete))[0].garminScheduleId).toBeNull();

    const second = await sync();
    expect(second.counts.rescheduled).toBe(1);

    const after = await stub.state();
    expect(after.workouts).toHaveLength(1);
    expect(after.schedules).toHaveLength(1);
  });

  it('puts a workout back when the athlete deleted it in the Connect app', async () => {
    const created = await write(INTERVALS);
    await sync();
    const before = await stub.state();

    // Gone from Garmin, but our link still names it — which every later sync
    // would otherwise fail on, for good.
    await stub.forget();

    // Change it here too, so the sync has a reason to reach for the stale id
    // rather than reporting it unchanged.
    await rewrite(created.id, { ...INTERVALS, name: 'Back again' });

    const report = await sync();
    expect(report.counts.failed).toBe(0);
    expect(report.counts.created).toBe(1);

    const after = await stub.state();
    expect(after.workouts).toHaveLength(1);
    expect(after.workouts[0].id).not.toBe(before.workouts[0].id);
    expect(after.workouts[0].payload.workoutName).toBe('Back again');
    expect(after.schedules).toHaveLength(1);
    expect(after.schedules[0].date).toBe(DAY);

    // And it settles: the next run has nothing left to do.
    expect((await sync()).counts.unchanged).toBe(1);
  });

  it('refreshes an expired token and carries on', async () => {
    await write(INTERVALS);

    // Backdate the stored access token so the next sync has to refresh.
    await env.DB.prepare('UPDATE garmin_connections SET access_expires_at = ? WHERE user_id = ?')
      .bind(new Date(Date.now() - 60_000).toISOString(), athlete)
      .run();

    const report = await sync();
    expect(report.counts.created).toBe(1);

    const state = await stub.state();
    expect(state.calls.some((c) => c.grant === 'refresh_token')).toBe(true);
    // The rotated pair replaced the old one, so the next refresh works too.
    expect((await store.getConnection(env, athlete))?.accessToken).toBe(state.issued.at(-1));
  });

  it('refreshes once and retries when a token is invalidated mid-run', async () => {
    await write(INTERVALS);
    // The token looks fresh to us but Garmin has stopped honouring it, which
    // proactive refreshing cannot predict.
    await stub.fail({ expireTokens: true });

    const report = await sync();
    expect(report.counts.created).toBe(1);
    expect(report.counts.failed).toBe(0);

    const state = await stub.state();
    expect(state.calls.filter((c) => c.grant === 'refresh_token')).toHaveLength(1);
  });

  it('refuses a second sync while one is already running', async () => {
    await write(INTERVALS);
    // Claimed as another run would claim it, and not released.
    expect(await store.claimSync(env, athlete)).toBe(true);

    const response = await SELF.fetch(`${BASE}/api/sync`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('already running') });

    // Nothing was pushed behind the lock, so no duplicate is possible.
    expect(training(await stub.state())).toHaveLength(0);

    // And it is released afterwards, so the next sync is not locked out.
    await store.releaseSync(env, athlete);
    expect((await sync()).counts.created).toBe(1);
  });

  it('lets a preview through while a sync holds the lock', async () => {
    await write(INTERVALS);
    expect(await store.claimSync(env, athlete)).toBe(true);

    // A dry run changes nothing on either side, so waiting on the lock would
    // only stop someone looking at what the running sync is doing.
    const report = await sync({ dry_run: true });
    expect(report.counts.created).toBe(1);
    expect(training(await stub.state())).toHaveLength(0);
  });

  it('releases the lock even when the run fails outright', async () => {
    await stub.fail({ rejectNamed: '8x400m' });
    await write(INTERVALS);

    expect((await sync()).counts.failed).toBe(1);
    // Not still held: the next attempt gets the lock rather than a 409.
    expect(await store.claimSync(env, athlete)).toBe(true);
  });

  it('reclaims a lock left behind by a run that died', async () => {
    await env.DB.prepare('UPDATE garmin_connections SET sync_locked_at = ? WHERE user_id = ?')
      .bind(new Date(Date.now() - 10 * 60_000).toISOString(), athlete)
      .run();

    await write(INTERVALS);
    expect((await sync()).counts.created).toBe(1);
  });

  it('stops on the shared call budget rather than pushing past it', async () => {
    // Three workouts at two calls each — a create and a schedule — and a
    // budget for two of them with one call to spare.
    await write(INTERVALS);
    await write({ ...INTERVALS, date: OTHER_DAY, name: 'Second' });
    await write({ ...INTERVALS, date: shiftDate(today(), 6), name: 'Third' });

    const report = await syncAll(env, athlete, { budget: newBudget(5) });
    expect(report.counts.created).toBe(2);
    expect(report.counts.skipped).toBe(1);
    expect(report.truncated).toBe(true);
    // Skipped is not failed: nothing is wrong, there was just no room.
    expect(report.counts.failed).toBe(0);
    expect(report.error).toBeUndefined();
    // And the run spent what it had rather than stopping short of it: the
    // odd call left over could not have paid for a third workout.
    expect(training(await stub.state())).toHaveLength(4);

    // The next run finishes the job, because the diff comes from stored state.
    const rest = await syncAll(env, athlete);
    expect(rest.counts.created).toBe(1);
    expect(rest.counts.unchanged).toBe(2);
  });

  it('affords a single create on a budget of exactly two', async () => {
    await write(INTERVALS);
    const report = await syncAll(env, athlete, { budget: newBudget(2) });
    expect(report.counts.created).toBe(1);
    expect(report.truncated).toBe(false);
  });

  it('puts a workout deleted on Garmin back when everything is re-sent', async () => {
    await write(INTERVALS);
    await sync();
    const before = await stub.state();

    // Deleted in the Connect app, and nothing changed here — so an ordinary
    // sync has no reason to touch it and reports it unchanged.
    await stub.forget();
    expect((await sync()).counts.unchanged).toBe(1);
    expect((await stub.state()).workouts).toHaveLength(0);

    // Re-sending is what notices, and what puts it back.
    const resent = await sync({ force: true });
    expect(resent.counts.created).toBe(1);

    const after = await stub.state();
    expect(after.workouts).toHaveLength(1);
    expect(after.workouts[0].id).not.toBe(before.workouts[0].id);
    expect(after.schedules).toHaveLength(1);
  });

  it('ticks off a session Garmin says was done', async () => {
    // Yesterday, so it is a session that could plausibly have happened.
    const yesterday = shiftDate(today(), -1);
    const created = await write({ ...INTERVALS, date: yesterday, name: 'Yesterday run' });
    await stub.activities([
      activity({
        activityName: 'Evening Run',
        startTimeInSeconds: Date.parse(`${yesterday}T18:00:00Z`) / 1000,
      }),
    ]);

    const report = await sync();
    expect(report.completed).toHaveLength(1);
    expect(report.completed[0]).toMatchObject({
      date: yesterday,
      id: created.id,
      name: 'Yesterday run',
      activity: 'Evening Run',
    });

    // Recorded through the same write the dashboard's tick uses, so it reads
    // back as an ordinary completion.
    const stored = await getWorkout(env, athlete, yesterday, created.id);
    expect(stored?.completed_at).toBe(new Date(Date.parse(`${yesterday}T18:00:00Z`)).toISOString());
  });

  it('does not ask about sessions that cannot have happened yet', async () => {
    // The fixture plan is two days out, so there is nothing to complete and
    // no reason to spend three calls finding that out.
    await write(INTERVALS);
    await sync();

    const state = await stub.state();
    expect(state.calls.filter((c) => c.what?.includes('activity-api'))).toHaveLength(0);
  });

  it('does not tick a session off with an activity from another sport', async () => {
    const yesterday = shiftDate(today(), -1);
    await write({ ...INTERVALS, date: yesterday, name: 'Run' });
    await stub.activities([
      activity({ activityType: 'LAP_SWIMMING', startTimeInSeconds: Date.parse(`${yesterday}T18:00:00Z`) / 1000 }),
    ]);

    expect((await sync()).completed).toHaveLength(0);
  });

  it('is idempotent: a second sync does not re-complete or re-ask', async () => {
    const yesterday = shiftDate(today(), -1);
    await write({ ...INTERVALS, date: yesterday, name: 'Run' });
    await stub.activities([activity({ startTimeInSeconds: Date.parse(`${yesterday}T18:00:00Z`) / 1000 })]);

    expect((await sync()).completed).toHaveLength(1);
    const after = (await stub.state()).calls.length;

    const again = await sync();
    expect(again.completed).toHaveLength(0);
    // Nothing outstanding, so it does not even ask.
    expect((await stub.state()).calls).toHaveLength(after);
  });

  it('never clears a completion Garmin has no activity for', async () => {
    const yesterday = shiftDate(today(), -1);
    const created = await write({ ...INTERVALS, date: yesterday, name: 'Treadmill, logged by hand' });
    // Ticked off here, and Garmin knows nothing about it.
    await setCompleted(env, athlete, yesterday, created.id, new Date().toISOString());
    await stub.activities([]);

    await sync();
    expect((await getWorkout(env, athlete, yesterday, created.id))?.completed_at).toBeTruthy();
  });

  it('still reports the push when Garmin will not talk about history', async () => {
    const yesterday = shiftDate(today(), -1);
    await write({ ...INTERVALS, date: yesterday, name: 'Run' });
    await stub.fail({ refuseActivities: true });

    const report = await sync();
    // The half that matters worked, and the half that did not says so.
    expect(report.counts.created).toBe(1);
    expect(report.counts.failed).toBe(0);
    expect(report.completed).toHaveLength(0);
    expect(report.completed_note).toContain('would not say');
  });

  it('says a preview cannot ask what was completed', async () => {
    const yesterday = shiftDate(today(), -1);
    await write({ ...INTERVALS, date: yesterday, name: 'Run' });

    const report = await sync({ dry_run: true });
    expect(report.completed).toHaveLength(0);
    expect(report.completed_note).toContain('makes no calls');
    expect((await stub.state()).calls).toHaveLength(1); // the connect token only
  });

  it('spends its budget on the plan before on history', async () => {
    const yesterday = shiftDate(today(), -1);
    await write({ ...INTERVALS, date: yesterday, name: 'Run' });
    await stub.activities([activity({ startTimeInSeconds: Date.parse(`${yesterday}T18:00:00Z`) / 1000 })]);

    // Two calls: exactly enough to create and schedule, and nothing over.
    const report = await syncAll(env, athlete, { budget: newBudget(2) });
    expect(report.counts.created).toBe(1);
    expect(report.completed).toHaveLength(0);
    expect(report.completed_note).toContain('Ran out of calls');
    expect(report.truncated).toBe(true);
  });

  it('asks the athlete to reconnect when the refresh is refused', async () => {
    await stub.fail({ refuseRefresh: true });
    await env.DB.prepare('UPDATE garmin_connections SET access_expires_at = ? WHERE user_id = ?')
      .bind(new Date(Date.now() - 60_000).toISOString(), athlete)
      .run();

    const response = await SELF.fetch(`${BASE}/api/sync`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('Garmin') });
  });
});

describe('pushing after a write', () => {
  let cookie: string;
  let athlete: string;

  const post = (path: string, body: unknown) =>
    SELF.fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    cookie = await connectGarmin();
    athlete = (await currentUserId())!;
  });

  it('puts a workout on the calendar without being asked to sync', async () => {
    const response = await post('/api/workouts', INTERVALS);
    expect(response.status).toBe(201);

    await eventually((state) => {
      expect(state.workouts).toHaveLength(1);
      expect(state.schedules).toHaveLength(1);
      expect(state.schedules[0].date).toBe(DAY);
    });
    expect(await store.listLinks(env, athlete)).toHaveLength(1);
  });

  it('pushes a workout created over MCP too', async () => {
    // The same tool an assistant calls, over the same transport.
    const response = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await tokenFor(athlete)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_workout', arguments: INTERVALS },
      }),
    });
    expect(response.status).toBe(200);
    await eventually((state) => expect(state.schedules).toHaveLength(1));
  });

  it('takes a workout off the calendar when it is deleted', async () => {
    const created = (await post('/api/workouts', INTERVALS).then((r) => r.json())) as { date: string; id: string };
    await eventually((state) => expect(state.schedules).toHaveLength(1));

    await SELF.fetch(`${BASE}/api/workouts/${created.date}/${created.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });

    await eventually((state) => {
      expect(state.schedules).toHaveLength(0);
      expect(state.workouts).toHaveLength(0);
    });
  });

  it('pushes the whole plan when it is written a workout at a time', async () => {
    // The case the resync mark exists for: an assistant filling in a week.
    // Whichever push wins the lock must end up having pushed all of them, not
    // just the ones that existed when it started.
    const days = [0, 1, 2, 3, 4].map((offset) => shiftDate(today(), offset + 1));
    await Promise.all(days.map((date, index) => post('/api/workouts', { ...INTERVALS, date, name: `Day ${index}` })));

    await eventually((state) => {
      expect(state.workouts).toHaveLength(days.length);
      expect(state.schedules.map((entry) => entry.date).sort()).toEqual([...days].sort());
      // And nothing was pushed twice: one calendar entry per workout.
      expect(new Set(state.schedules.map((entry) => entry.workoutId)).size).toBe(days.length);
    });

    // A sync afterwards has nothing left to do, which is the real assertion:
    // the plan is entirely on the calendar.
    const report = await syncAll(env, athlete);
    expect(report.counts.unchanged).toBe(days.length);
    expect(report.counts.created).toBe(0);
  });

  it('never lets Garmin break a write', async () => {
    // Every Garmin call refused. The workout still saves, and the athlete is
    // told nothing about Garmin on the way.
    await stub.fail({ rejectNamed: '8x400m' });

    const response = await post('/api/workouts', INTERVALS);
    expect(response.status).toBe(201);
    const created = (await response.json()) as { date: string; id: string };
    expect(created.date).toBe(DAY);

    // Saved here regardless, which is the whole reason the push is scheduled
    // rather than awaited.
    expect(await getWorkout(env, athlete, DAY, created.id)).toMatchObject({ name: '8x400m' });
    // And the failure is on the connection row for the dashboard to show,
    // not on the response the athlete just got.
    await vi.waitFor(async () =>
      expect((await store.getConnection(env, athlete))?.lastSyncError).toContain('could not be synced'),
    );
  });

  it('does not push for an athlete who has not connected Garmin', async () => {
    await SELF.fetch(`${BASE}/api/garmin/disconnect`, { method: 'POST', headers: { Cookie: cookie } });
    await stub.reset();

    const response = await post('/api/workouts', INTERVALS);
    expect(response.status).toBe(201);

    // An explicit sync refusing for want of a connection proves the state,
    // and by the time it has run the background push has had its chance.
    await expect(syncAll(env, athlete)).rejects.toThrow(/no Garmin account/);
    expect(training(await stub.state())).toHaveLength(0);
  });

  it('bounds how many times a run goes round for late writes', () => {
    // A plan being written continuously must not keep one run going forever.
    expect(MAX_SYNC_PASSES).toBeGreaterThan(1);
    expect(MAX_SYNC_PASSES).toBeLessThanOrEqual(5);
  });
});

describe('the nightly sweep', () => {
  let athlete: string;

  beforeEach(async () => {
    await connectGarmin();
    athlete = (await currentUserId())!;
  });

  it('pushes for an athlete who asked for it', async () => {
    await putWorkout(env, athlete, parseWorkout(INTERVALS));

    expect(await syncEveryone(env)).toMatchObject({ users: 1, pushed: 1, failed: 0, budgetSpent: false });
    expect((await stub.state()).schedules).toHaveLength(1);
  });

  it('leaves out an athlete who turned the nightly sync off', async () => {
    await store.setAutoSync(env, athlete, false);
    expect(await syncEveryone(env)).toMatchObject({ users: 0, pushed: 0 });
    expect(training(await stub.state())).toHaveLength(0);
  });

  it('does not count a locked athlete as a failure', async () => {
    expect(await store.claimSync(env, athlete)).toBe(true);
    expect(await syncEveryone(env)).toMatchObject({ failed: 0, pushed: 0 });
  });

  it('reports a busy sync as its own kind of outcome', async () => {
    expect(await store.claimSync(env, athlete)).toBe(true);
    await expect(syncAll(env, athlete)).rejects.toBeInstanceOf(SyncBusyError);
  });
});

describe('status, settings and disconnecting', () => {
  let cookie: string;

  const get = (path: string, init: RequestInit = {}) =>
    SELF.fetch(`${BASE}${path}`, { ...init, headers: { Cookie: cookie, 'Content-Type': 'application/json', ...init.headers } });

  beforeEach(async () => {
    cookie = await sessionCookieFor();
  });

  it('reports a configured but unconnected server', async () => {
    expect(await get('/api/garmin/status').then((r) => r.json())).toMatchObject({
      configured: true,
      connected: false,
    });
  });

  it('reports the connection and what it has synced', async () => {
    await connectGarmin(cookie);
    await get('/api/workouts', { method: 'POST', body: JSON.stringify(INTERVALS) });
    await get('/api/sync', { method: 'POST', body: '{}' });

    expect(await get('/api/garmin/status').then((r) => r.json())).toMatchObject({
      connected: true,
      garmin_user_id: 'garmin-athlete-1',
      auto_sync: true,
      synced_workouts: 1,
      last_sync_error: null,
    });
  });

  it('turns the nightly sync off and leaves on-demand syncing alone', async () => {
    await connectGarmin(cookie);
    const updated = await get('/api/garmin/settings', { method: 'PUT', body: JSON.stringify({ auto_sync: false }) });
    expect(await updated.json()).toMatchObject({ auto_sync: false });

    expect(await store.autoSyncUserIds(env, 10)).toHaveLength(0);
  });

  it('refuses a settings change with no connection to change', async () => {
    const response = await get('/api/garmin/settings', { method: 'PUT', body: JSON.stringify({ auto_sync: false }) });
    expect(response.status).toBe(404);
  });

  it('disconnects, tells Garmin, and leaves the calendar as it is', async () => {
    await connectGarmin(cookie);
    await get('/api/workouts', { method: 'POST', body: JSON.stringify(INTERVALS) });
    await get('/api/sync', { method: 'POST', body: '{}' });

    const response = await get('/api/garmin/disconnect', { method: 'POST' });
    expect(await response.json()).toMatchObject({ disconnected: true, deregistered: true });

    // Our own state is gone...
    expect(await get('/api/garmin/status').then((r) => r.json())).toMatchObject({ connected: false });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM garmin_workouts').first<{ n: number }>()).toMatchObject({
      n: 0,
    });

    // ...and the sessions already on the athlete's calendar are not.
    const state = await stub.state();
    expect(state.schedules).toHaveLength(1);
    expect(state.calls.some((c) => c.what === 'deregister')).toBe(true);
  });
});

describe('the MCP tools', () => {
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await response.json()) as {
      result: {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: Record<string, unknown>;
      };
    };
  };

  it('exposes syncing and nothing else — linking is a one-time browser step', async () => {
    const response = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const { result } = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    const names = result.tools.map((t) => t.name);

    expect(names).toContain('sync_workouts');
    // Nothing Garmin-named at all: the tool surface is provider-neutral.
    expect(names.filter((name) => name.includes('garmin'))).toEqual([]);
  });

  it('answers a sync with nothing linked by saying where to link it', async () => {
    const { result } = await tool('sync_workouts');
    // Not an error: with more than one platform possible, one being unlinked
    // is a state to report rather than a failure of the whole call.
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      providers: [
        {
          provider: 'garmin',
          label: 'Garmin Connect',
          connected: false,
          // The one URL these tools hand back, because it is a page to open
          // rather than bytes behind a credential.
          connect_url: `${BASE}/garmin/connect`,
        },
      ],
    });
  });

  it('leaves the payloads out of a dry run unless asked', async () => {
    // The API-token user and the session user are the same athlete only if we
    // connect for the token's own user, so drive the store directly here.
    await store.saveTokens(
      env,
      userId,
      {
        accessToken: 'garmin-access-manual',
        refreshToken: 'garmin-refresh-manual',
        accessExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        refreshExpiresAt: null,
      },
      'garmin-athlete-1',
    );
    await store_workout();

    type Outcome = { providers: Array<{ report: { workouts: Array<Record<string, unknown>> } }> };
    const workoutsOf = (result: { structuredContent?: Record<string, unknown> }) =>
      (result.structuredContent as unknown as Outcome).providers[0].report.workouts;

    const lean = await tool('sync_workouts', { dry_run: true });
    expect(workoutsOf(lean.result)).toHaveLength(1);
    expect(workoutsOf(lean.result)[0].payload).toBeUndefined();

    const full = await tool('sync_workouts', { dry_run: true, include_payloads: true });
    expect(workoutsOf(full.result)[0].payload).toMatchObject({ workoutName: '8x400m' });
  });
});
