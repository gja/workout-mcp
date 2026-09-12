import { SELF, createScheduledController, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { Decoder, Stream } from '@garmin/fitsdk';
import worker from '../src/index';
import { shiftDate, today } from '../src/units';
import { connectIntervals, resetDatabase, seedUser } from './helpers';

const BASE = 'https://workouts.example';

/** What the stand-in's token endpoint issues. See `test/upstream-provider.js`. */
const TOKEN = 'intervals-access-token';

/** The athlete the stand-in says the token belongs to. */
const ATHLETE_ID = 'i99999';

/** Both halves of what makes a webhook ours, as `vitest.config.ts` sets them. */
const SECRET = 'test-intervals-webhook-secret';
const HEADER = 'test-intervals-webhook-header';

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

const connect = (code = 'ok') => connectIntervals({ Authorization: `Bearer ${token}` }, code);

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
  const body = (await (await call('/api/config')).json()) as {
    credentials_configured: boolean;
    platforms: Array<{
      id: string;
      connected: boolean;
      account: string | null;
      last_error: string | null;
      synced: number;
      connected_note: string | null;
    }>;
  };
  return { ...body, intervals: body.platforms.find((platform) => platform.id === 'intervals')! };
};

beforeEach(async () => {
  await resetDatabase();
  await control('reset');
  ({ id: userId, token } = await seedUser());
});

describe('connecting a platform', () => {
  it('takes the athlete through OAuth, names the account, and pushes what is already planned', async () => {
    const planned = await createWorkout();

    const response = await connect();
    // A redirect back to the dashboard, not a body: the round ends at a callback.
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(`${BASE}/`);

    const status = await platformStatus();
    expect(status.intervals).toMatchObject({ connected: true, account: 'Test Athlete', last_error: null });

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

  it('spends the code at the connect callback, which is not the sign-in one', async () => {
    await connect();
    const { tokenExchanges } = await control<{ tokenExchanges: Array<{ redirect_uri: string }> }>('state');
    expect(tokenExchanges).toHaveLength(1);
    expect(tokenExchanges[0].redirect_uri).toBe(`${BASE}/auth/intervals/connect-callback`);
  });

  it('stores nothing when the athlete refuses, and says so on the way back', async () => {
    const response = await connect('denied');
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toContain('error=');
    expect((await platformStatus()).intervals.connected).toBe(false);
  });

  // Nothing is verified before the grant is stored — their token endpoint already
  // said whose it is — so a token they will not honour is a connection with a
  // standing error, not a refusal.
  it('keeps a grant whose first sync fails, and reports why', async () => {
    await createWorkout();
    expect((await connect('revoked')).status).toBe(302);

    const status = await platformStatus();
    expect(status.intervals.connected).toBe(true);
    expect(status.intervals.last_error).toContain('401');
  });

  it('refuses to start the round for a caller with no session', async () => {
    const response = await SELF.fetch(`${BASE}/auth/intervals/connect`, { redirect: 'manual' });
    expect(response.status).toBe(401);
  });

  it('encrypts the stored token rather than keeping it in the clear', async () => {
    await connect();
    const row = await env.DB.prepare('SELECT secret, account_id FROM platform_connections WHERE user_id = ?')
      .bind(userId)
      .first<{ secret: string; account_id: string }>();
    expect(row?.secret).toBeTruthy();
    expect(row!.secret).not.toContain(TOKEN);
    // Kept in the clear on purpose: a webhook names the athlete and nothing else.
    expect(row!.account_id).toBe('i99999');
  });

  it('lists a platform that is not connected, so the dashboard can offer it', async () => {
    const status = await platformStatus();
    expect(status.credentials_configured).toBe(true);
    expect(status.intervals).toMatchObject({ connected: false, synced: 0 });
  });

  /**
   * intervals.icu reads every target against a threshold on the athlete's own
   * profile, so a plan we encode correctly still lands without a usable target
   * when one is missing. The dashboard says so; nothing here can supply them.
   */
  it('carries the note pointing an athlete at their thresholds', async () => {
    const { intervals } = await platformStatus();
    expect(intervals.connected_note).toContain('threshold pace and FTP');
  });

  it('404s an unknown platform', async () => {
    const response = await call('/api/config/strava', { method: 'PUT', body: JSON.stringify({ key: 'x' }) });
    expect(response.status).toBe(404);
  });
});

describe('pushing workout changes', () => {
  beforeEach(async () => {
    expect((await connect()).status).toBe(302);
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
    const before = (await calendar())[0].id;

    const response = await call(`/api/workouts/${planned.date}/${planned.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...WORKOUT, name: 'Renamed' }),
    });
    expect(response.status).toBe(200);

    const events = await calendar();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(before);
    expect(events[0].name).toBe('Renamed');
  });

  // The upsert key travels with the workout, so the link row is a shortcut rather
  // than the only thing standing between an edit and a duplicate.
  it('lands on the event already there even with no link row left', async () => {
    const planned = await createWorkout();
    const before = (await calendar())[0].id;
    await env.DB.prepare('DELETE FROM platform_links WHERE user_id = ?').bind(userId).run();

    const response = await call(`/api/workouts/${planned.date}/${planned.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...WORKOUT, name: 'Renamed' }),
    });
    expect(response.status).toBe(200);

    const events = await calendar();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(before);
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
    expect((await call('/api/config/intervals', { method: 'DELETE' })).status).toBe(200);

    await createWorkout();
    expect(await calendar()).toHaveLength(0);
    expect((await platformStatus()).intervals).toMatchObject({ connected: false, synced: 0 });
  });
});

describe('syncing on demand', () => {
  it('pushes only what has changed since the last run', async () => {
    await connect();
    await createWorkout();

    const first = (await (await call('/api/sync/intervals', { method: 'POST' })).json()) as {
      pushed: number;
      remaining: number;
    };
    expect(first).toMatchObject({ pushed: 0, remaining: 0 });

    // A workout the platform never saw, because it was down at the time.
    await control('setup', { failing: { '/events': 500 } });
    await createWorkout({ ...WORKOUT, date: OTHER_DAY, name: 'Missed' });
    await control('setup', { failing: {} });

    const second = (await (await call('/api/sync/intervals', { method: 'POST' })).json()) as {
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

    const response = await call('/api/sync/intervals', { method: 'POST' });
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

    const sync = (await (await call('/api/sync/intervals', { method: 'POST' })).json()) as {
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

    const sync = (await (await call('/api/sync/intervals', { method: 'POST' })).json()) as {
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

    await call('/api/sync/intervals', { method: 'POST' });
    const again = (await (await call('/api/sync/intervals', { method: 'POST' })).json()) as {
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

describe('disconnecting', () => {
  const revoked = async (): Promise<string[]> => (await control<{ revoked: string[] }>('state')).revoked;

  it('hands the grant back, so the app leaves their intervals.icu settings too', async () => {
    await connect();
    expect((await call('/api/config/intervals', { method: 'DELETE' })).status).toBe(200);

    expect(await revoked()).toEqual([TOKEN]);
    expect((await platformStatus()).intervals.connected).toBe(false);
  });

  // Their call releases the *app* for that athlete, not one token of it, and one
  // athlete legitimately maps to more than one account here. See docs/auth.md.
  it('keeps the grant when another account here is connected to the same athlete', async () => {
    await connect();

    const other = await seedUser('other@example.com');
    await connectIntervals({ Authorization: `Bearer ${other.token}` });

    expect((await call('/api/config/intervals', { method: 'DELETE' })).status).toBe(200);
    expect(await revoked()).toEqual([]);

    // Ours is gone all the same — forgetting our copy is what was asked for.
    expect((await platformStatus()).intervals.connected).toBe(false);
  });
});

describe('the intervals.icu webhook', () => {
  const WEBHOOK = '/webhooks/intervals';

  /** Their shape: a secret to prove it is them, and a batch of events. */
  const post = (body: unknown, headers: Record<string, string> = { Authorization: HEADER }) =>
    SELF.fetch(`${BASE}${WEBHOOK}`, { method: 'POST', headers, body: JSON.stringify(body) });

  const analysed = (athleteId = ATHLETE_ID) => ({
    secret: SECRET,
    events: [{ athlete_id: athleteId, type: 'ACTIVITY_ANALYZED', timestamp: new Date().toISOString() }],
  });

  /** A recorded activity intervals.icu has paired with the event we pushed. */
  const pairAnActivity = async (eventId: number) => {
    await control('setup', {
      activities: [{ id: 'w1', paired_event_id: eventId, start_date_local: `${DAY}T06:30:00` }],
    });
  };

  it('marks the paired workout done without waiting for the hourly pass', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pairAnActivity(event.id);

    const response = await post(analysed());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ matched: 1, marked: 1 });

    const workout = (await (await call(`/api/workouts/${planned.date}/${planned.id}`)).json()) as {
      completed_at?: string;
    };
    expect(workout.completed_at).toBeTruthy();
  });

  // The body is believed for the athlete id and nothing else: what actually marks
  // the workout done is the pairing, read back over their API.
  it('marks nothing when the activity is not paired with anything of ours', async () => {
    await connect();
    await createWorkout();
    await control('setup', { activities: [{ id: 'w2', start_date_local: `${DAY}T06:30:00` }] });

    expect(await (await post(analysed())).json()).toMatchObject({ matched: 1, marked: 0 });
  });

  it('refuses a body whose secret is not the one they were given', async () => {
    await connect();
    const response = await post({ ...analysed(), secret: 'not-the-secret' });
    expect(response.status).toBe(401);
  });

  it('refuses a request without the authorization header configured on their end', async () => {
    await connect();
    expect((await post(analysed(), {})).status).toBe(401);
    expect((await post(analysed(), { Authorization: 'Bearer wrong' })).status).toBe(401);
  });

  it('ignores an event type that does not mean a session was completed', async () => {
    await connect();
    const response = await post({
      secret: SECRET,
      events: [{ athlete_id: ATHLETE_ID, type: 'ACTIVITY_UPLOADED' }],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ athletes: 0, marked: 0 });
  });

  // A permanent condition — no retry would ever do better — so it is not an error.
  it('accepts an event for an athlete nobody here has connected, and does nothing', async () => {
    const response = await post({
      secret: SECRET,
      events: [{ athlete_id: 'i00000', type: 'ACTIVITY_ANALYZED' }],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ matched: 0, marked: 0 });
  });

  it('asks to be retried when the platform cannot be read back', async () => {
    await connect();
    await createWorkout();
    await control('setup', { failing: { '/activities': 500 } });

    expect((await post(analysed())).status).toBe(502);
  });
});
