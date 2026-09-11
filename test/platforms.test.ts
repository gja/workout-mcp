import { SELF, createScheduledController, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { Decoder, Stream } from '@garmin/fitsdk';
import worker from '../src/index';
import { shiftDate, today } from '../src/units';
import { resetDatabase, seedUser } from './helpers';

const BASE = 'https://workouts.example';
const KEY = 'an-intervals-api-key';

let token: string;
let userId: string;

/** Arrange or read the stand-in intervals.icu, through its service binding. */
const control = async <T>(path: string, body?: unknown): Promise<T> => {
  const response = await env.INTERVALS.fetch(`https://intervals.icu/__control/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
};

type StandInEvent = {
  id: number;
  uid: string;
  name: string;
  type: string;
  category: string;
  indoor: boolean;
  external_id: string;
  start_date_local: string;
  filename: string;
  file_contents_base64: string;
};

const calendar = async (): Promise<StandInEvent[]> =>
  (await control<{ events: StandInEvent[] }>('state')).events;

const call = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });

const connect = (key = KEY) => call('/api/platforms/intervals', { method: 'PUT', body: JSON.stringify({ key }) });

const DAY = shiftDate(today(), 2);
const OTHER_DAY = shiftDate(today(), 3);

const WORKOUT = {
  date: DAY,
  name: '8x400m',
  sport: 'running',
  steps: [
    { name: 'Warmup', goal_s: 600, target_heart_rate: [146, 153] },
    { repeat: 8, steps: [{ name: 'Fast', goal_meters: 400, target_pace_km: ['4:00', '4:15'] }] },
  ],
};

const createWorkout = async (body: unknown = WORKOUT): Promise<{ date: string; id: string }> => {
  const response = await call('/api/workouts', { method: 'POST', body: JSON.stringify(body) });
  expect(response.status).toBe(201);
  return (await response.json()) as { date: string; id: string };
};

const platformStatus = async () => {
  const body = (await (await call('/api/platforms')).json()) as {
    configured: boolean;
    platforms: Array<{ id: string; connected: boolean; account: string | null; last_error: string | null; synced: number }>;
  };
  return { ...body, intervals: body.platforms.find((platform) => platform.id === 'intervals')! };
};

beforeEach(async () => {
  await resetDatabase();
  await control('reset');
  ({ id: userId, token } = await seedUser());
});

describe('connecting a platform', () => {
  it('verifies the key, names the account, and pushes what is already planned', async () => {
    const planned = await createWorkout();

    const response = await connect();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account: 'Test Athlete', sync: { pushed: 1, error: null } });

    const events = await calendar();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: 'WORKOUT',
      name: '8x400m',
      type: 'Run',
      external_id: planned.id,
      start_date_local: `${DAY}T00:00:00`,
    });
  });

  it('refuses a key the platform does not accept, and stores nothing', async () => {
    const response = await connect('revoked-key');
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('401');
    expect((await platformStatus()).intervals.connected).toBe(false);
  });

  it('refuses an empty key without calling out', async () => {
    expect((await connect('   ')).status).toBe(400);
  });

  it('encrypts the stored key rather than keeping it in the clear', async () => {
    await connect();
    const row = await env.DB.prepare('SELECT secret FROM platform_connections WHERE user_id = ?')
      .bind(userId)
      .first<{ secret: string }>();
    expect(row?.secret).toBeTruthy();
    expect(row!.secret).not.toContain(KEY);
  });

  it('lists a platform that is not connected, so the dashboard can offer it', async () => {
    const status = await platformStatus();
    expect(status.configured).toBe(true);
    expect(status.intervals).toMatchObject({ connected: false, synced: 0 });
  });

  it('404s an unknown platform', async () => {
    const response = await call('/api/platforms/strava', { method: 'PUT', body: JSON.stringify({ key: 'x' }) });
    expect(response.status).toBe(404);
  });
});

describe('pushing workout changes', () => {
  beforeEach(async () => {
    expect((await connect()).status).toBe(200);
  });

  it('sends the workout as a FIT file the watch would get', async () => {
    await createWorkout();
    const [event] = await calendar();

    expect(event.filename).toMatch(/\.fit$/);
    const bytes = Uint8Array.from(atob(event.file_contents_base64), (character) => character.charCodeAt(0));
    const { messages } = new Decoder(Stream.fromByteArray(bytes)).read();
    expect(messages.workoutMesgs?.[0]?.wktName).toBe('8x400m');
    // Warmup, the repeated step, and the repeat that closes it.
    expect(messages.workoutStepMesgs ?? []).toHaveLength(3);
  });

  it('updates the same calendar event instead of adding a second one', async () => {
    const planned = await createWorkout();

    const response = await call(`/api/workouts/${planned.date}/${planned.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...WORKOUT, name: 'Renamed' }),
    });
    expect(response.status).toBe(200);

    const events = await calendar();
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('Renamed');
  });

  it('moves an event with the workout rather than leaving a copy behind', async () => {
    const planned = await createWorkout();
    const before = (await calendar())[0].id;

    const response = await call(`/api/workouts/${planned.date}/${planned.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...WORKOUT, date: OTHER_DAY }),
    });
    expect(response.status).toBe(200);

    const events = await calendar();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(before);
    expect(events[0].start_date_local).toBe(`${OTHER_DAY}T00:00:00`);
  });

  it('deletes the event when the workout is deleted', async () => {
    const planned = await createWorkout();
    expect(await calendar()).toHaveLength(1);

    expect((await call(`/api/workouts/${planned.date}/${planned.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await calendar()).toHaveLength(0);
  });

  it('carries the sub-sport across as the platform’s own activity type', async () => {
    await createWorkout({ ...WORKOUT, sport: 'cycling', sub_sport: 'indoor_cycling' });
    expect((await calendar())[0]).toMatchObject({ type: 'Ride', indoor: true });
  });

  it('syncs a workout written over MCP, not only one written over REST', async () => {
    const response = await call('/api/tools/create_workout', { method: 'POST', body: JSON.stringify(WORKOUT) });
    expect(response.status).toBe(200);
    expect(await calendar()).toHaveLength(1);
  });

  it('does not fail the athlete’s own write when the platform is down', async () => {
    await control('setup', { failing: { '/events': 502 } });

    const planned = await createWorkout();
    expect(planned.id).toBeTruthy();

    const status = await platformStatus();
    expect(status.intervals.last_error).toContain('502');
    expect(status.intervals.synced).toBe(0);
  });

  it('pushes nothing once the platform is disconnected', async () => {
    expect((await call('/api/platforms/intervals', { method: 'DELETE' })).status).toBe(200);

    await createWorkout();
    expect(await calendar()).toHaveLength(0);
    expect((await platformStatus()).intervals).toMatchObject({ connected: false, synced: 0 });
  });
});

describe('syncing on demand', () => {
  it('pushes only what has changed since the last run', async () => {
    await connect();
    await createWorkout();

    const first = (await (await call('/api/platforms/intervals/sync', { method: 'POST' })).json()) as {
      pushed: number;
      remaining: number;
    };
    expect(first).toMatchObject({ pushed: 0, remaining: 0 });

    // A workout the platform never saw, because it was down at the time.
    await control('setup', { failing: { '/events': 500 } });
    await createWorkout({ ...WORKOUT, date: OTHER_DAY, name: 'Missed' });
    await control('setup', { failing: {} });

    const second = (await (await call('/api/platforms/intervals/sync', { method: 'POST' })).json()) as {
      pushed: number;
      error: string | null;
    };
    expect(second).toMatchObject({ pushed: 1, error: null });
    expect((await calendar()).map((event) => event.name).sort()).toEqual(['8x400m', 'Missed']);
    expect((await platformStatus()).intervals.last_error).toBeNull();
  });

  it('reports the failure without throwing when the platform is unreachable', async () => {
    await connect();
    await createWorkout();
    await control('setup', { failing: { '/activities': 500 } });

    const response = await call('/api/platforms/intervals/sync', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('500') });
  });
});

describe('completions coming back', () => {
  it('marks a workout done when the platform has paired an activity with it', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();

    await control('setup', {
      activities: [
        {
          id: 'a1',
          paired_event_id: event.id,
          start_date: `${DAY}T06:30:00Z`,
          start_date_local: `${DAY}T06:30:00`,
        },
      ],
    });

    const sync = (await (await call('/api/platforms/intervals/sync', { method: 'POST' })).json()) as {
      completed: number;
    };
    expect(sync.completed).toBe(1);

    const workout = (await (await call(`/api/workouts/${planned.date}/${planned.id}`)).json()) as {
      completed_at?: string;
    };
    expect(workout.completed_at).toBe(new Date(`${DAY}T06:30:00Z`).toISOString());
  });

  /**
   * The hourly cron is the whole of the "and mark it done" half of the
   * integration: intervals.icu gives a pasted-in key no webhook to register,
   * so nothing arrives unless this pass goes and asks.
   */
  it('marks it done on the hourly pass, with nobody watching', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await control('setup', {
      activities: [{ id: 'a4', paired_event_id: event.id, start_date: `${DAY}T06:30:00Z` }],
    });

    await worker.scheduled!(createScheduledController({ cron: '20 * * * *' }), env);

    const workout = (await (await call(`/api/workouts/${planned.date}/${planned.id}`)).json()) as {
      completed_at?: string;
    };
    expect(workout.completed_at).toBe(new Date(`${DAY}T06:30:00Z`).toISOString());
  });

  it('ignores an activity paired with something we never pushed', async () => {
    await connect();
    await createWorkout();
    await control('setup', {
      activities: [{ id: 'a2', paired_event_id: 123456, start_date_local: `${DAY}T06:30:00` }],
    });

    const sync = (await (await call('/api/platforms/intervals/sync', { method: 'POST' })).json()) as {
      completed: number;
    };
    expect(sync.completed).toBe(0);
  });

  it('records the same completion once, leaving the workout alone on a second run', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await control('setup', {
      activities: [{ id: 'a3', paired_event_id: event.id, start_date_local: `${DAY}T06:30:00` }],
    });

    await call('/api/platforms/intervals/sync', { method: 'POST' });
    const again = (await (await call('/api/platforms/intervals/sync', { method: 'POST' })).json()) as {
      completed: number;
      pushed: number;
    };
    expect(again).toMatchObject({ completed: 0, pushed: 0 });

    const workout = (await (await call(`/api/workouts/${planned.date}/${planned.id}`)).json()) as {
      completed_at?: string;
    };
    expect(workout.completed_at).toBeTruthy();
  });
});
