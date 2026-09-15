import { SELF, createScheduledController, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { Decoder, Stream } from '@garmin/fitsdk';
import worker from '../src/index';
import { STATS_ATTEMPTS } from '../src/platforms';
import { shiftDate, today } from '../src/units';
import { base64Encode } from '../src/fit';
import { encodeActivityFit } from './activity-fit';
import type { LapSpec } from './activity-fit';
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
  tags: string[];
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

  /**
   * The Reconnect button is this round run again on a connection that already exists.
   * It has to land on the same connection: a grant whose scopes have since widened, or
   * a token revoked upstream, is fixed by taking another — not by disconnecting, which
   * hands the access back and drops what we know about the calendar.
   */
  it('renews a connection in place, keeping the links and clearing the error', async () => {
    const planned = await createWorkout();
    await connect('revoked');
    expect((await platformStatus()).intervals.last_error).toContain('401');

    expect((await connect()).status).toBe(302);

    const status = await platformStatus();
    expect(status.intervals).toMatchObject({ connected: true, account: 'Test Athlete', last_error: null });
    // One connection, and one event: the second round replaced the token rather than
    // adding a row, and the workout already pushed was not pushed again beside itself.
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM platform_connections WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const events = await calendar();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ external_id: planned.id });
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

  it('carries the tags across as the event’s own', async () => {
    await createWorkout({ ...WORKOUT, tags: ['key', 'threshold'] });
    expect((await calendar())[0].tags).toEqual(['key', 'threshold']);
  });

  // The push is an upsert over the event already there, so a tag taken off here
  // is only taken off there by the list arriving without it.
  it('clears the tags upstream when they are taken off the workout', async () => {
    const planned = await createWorkout({ ...WORKOUT, tags: ['key'] });

    const response = await call(`/api/workouts/${planned.date}/${planned.id}`, {
      method: 'PUT',
      body: JSON.stringify(WORKOUT),
    });
    expect(response.status).toBe(200);
    expect((await calendar())[0].tags).toEqual([]);
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

  it('ignores an event type that is not one of the two nudges', async () => {
    await connect();
    const response = await post({
      secret: SECRET,
      events: [{ athlete_id: ATHLETE_ID, type: 'ATHLETE_UPDATED' }],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ athletes: 0, marked: 0 });
  });

  // Their earlier event, which usually beats the pairing but sometimes does not.
  it('acts on an upload event too, not only the analysed one', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pairAnActivity(event.id);

    const response = await post({
      secret: SECRET,
      events: [{ athlete_id: ATHLETE_ID, type: 'ACTIVITY_UPLOADED' }],
    });
    expect(await response.json()).toMatchObject({ matched: 1, marked: 1 });

    const workout = (await (await call(`/api/workouts/${planned.date}/${planned.id}`)).json()) as {
      completed_at?: string;
    };
    expect(workout.completed_at).toBeTruthy();
  });

  // Both fire for one session; the link remembers the completion, so it lands once.
  it('marks a session once when both events arrive for it', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pairAnActivity(event.id);

    const upload = { secret: SECRET, events: [{ athlete_id: ATHLETE_ID, type: 'ACTIVITY_UPLOADED' }] };
    expect(await (await post(upload)).json()).toMatchObject({ marked: 1 });
    expect(await (await post(analysed())).json()).toMatchObject({ marked: 0 });

    const workout = (await (await call(`/api/workouts/${planned.date}/${planned.id}`)).json()) as {
      completed_at?: string;
    };
    expect(workout.completed_at).toBeTruthy();
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

  /** `WORKOUT` above, as the athlete ran it: a warmup and eight 400s, nine laps. */
  const AS_RUN = encodeActivityFit({
    laps: [
      { seconds: 600, speed: 2.7, hr: [100, 145] },
      ...Array.from({ length: 8 }, (): LapSpec => ({ seconds: 98, speed: 400 / 98, hr: [150, 172] })),
    ],
  });

  /** Paired, and with a FIT file of its own behind it. */
  const pairARecording = async (eventId: number, recording = AS_RUN) =>
    control('setup', {
      activities: [
        { id: 'w1', paired_event_id: eventId, start_date_local: `${DAY}T06:30:00`, file_type: 'fit' },
      ],
      recordings: { w1: base64Encode(recording) },
    });

  const recordingCalls = async () =>
    (await control<{ requests: Array<{ path: string }> }>('state')).requests.filter((request) =>
      /^\/api\/v1\/activity\//.test(request.path),
    );

  const statsFor = async (planned: { date: string; id: string }) =>
    (await call(`/api/workouts/${planned.date}/${planned.id}/stats`)).json() as Promise<{
      activity_id: string;
      session: { elapsed_s: number; avg_hr: number | null } | null;
      laps: Array<{ planned_step_name: string | null; match_confidence: string; quarters: unknown }>;
      flags: string[];
      error?: string;
      attempts?: number;
    }>;

  it('reads the recording behind the completion, and keeps the stats', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pairARecording(event.id);

    expect(await (await post(analysed())).json()).toMatchObject({ marked: 1 });

    const stats = await statsFor(planned);
    expect(stats.activity_id).toBe('w1');
    expect(stats.session?.elapsed_s).toBe(1384);
    expect(stats.laps).toHaveLength(9);
    expect(stats.laps[1]).toMatchObject({ planned_step_name: 'Fast', match_confidence: 'high' });
    expect(stats.laps[1].quarters).not.toBeNull();
  });

  // The laps are a page of JSON each, and every read of a workout would carry them.
  it('leaves the laps off the workout itself', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pairARecording(event.id);
    await post(analysed());

    const workout = (await (await call(`/api/workouts/${planned.date}/${planned.id}`)).json()) as {
      stats: Record<string, unknown>;
    };
    expect(workout.stats).toMatchObject({ activity_id: 'w1', flags: [] });
    expect(workout.stats).not.toHaveProperty('laps');
  });

  it('reads the file once, however many times the webhook fires', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pairARecording(event.id);

    await post(analysed());
    await post(analysed());
    await worker.scheduled!(createScheduledController({ cron: '20 * * * *' }), env);

    expect(await recordingCalls()).toHaveLength(1);
    expect((await statsFor(planned)).laps).toHaveLength(9);
  });

  // A manual entry, or one from Strava their API will not hand over.
  it('records a recording it could not read as exactly that, and does not thrash at it', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pairARecording(event.id);
    await control('setup', { failing: { '/activity/': 422 } });

    expect(await (await post(analysed())).json()).toMatchObject({ marked: 1 });

    const stats = await statsFor(planned);
    expect(stats.session).toBeNull();
    expect(stats.flags).toEqual(['source_unreadable']);
    expect(stats.error).toContain('422');
    expect(stats.attempts).toBe(1);

    // Three more deliveries in the same minute are the same outage, not three tries at it.
    for (let again = 0; again < 3; again += 1) await post(analysed());
    expect(await recordingCalls()).toHaveLength(1);
    expect((await statsFor(planned)).attempts).toBe(1);
  });

  it('keeps the stats when the workout is moved to another day', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pairARecording(event.id);
    await post(analysed());

    const moved = await call(`/api/workouts/${planned.date}/${planned.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...WORKOUT, date: OTHER_DAY }),
    });
    expect(moved.status).toBe(200);

    expect((await statsFor({ date: OTHER_DAY, id: planned.id })).laps).toHaveLength(9);
    expect((await call(`/api/workouts/${planned.date}/${planned.id}/stats`)).status).toBe(404);
  });

  it('asks for the FIT they build when the athlete uploaded something else', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    // No `file_type`: a Strava import or a GPX, where their own build is the only FIT there is.
    await control('setup', {
      activities: [{ id: 'w1', paired_event_id: event.id, start_date_local: `${DAY}T06:30:00` }],
      recordings: { w1: base64Encode(AS_RUN) },
    });

    expect(await (await post(analysed())).json()).toMatchObject({ marked: 1 });
    expect((await recordingCalls())[0].path).toContain('/fit-file');
    expect((await statsFor(planned)).laps).toHaveLength(9);
  });
});

describe('post-workout comments', () => {
  const WEBHOOK = '/webhooks/intervals';

  const analysed = () =>
    SELF.fetch(`${BASE}${WEBHOOK}`, {
      method: 'POST',
      headers: { Authorization: HEADER },
      body: JSON.stringify({
        secret: SECRET,
        events: [{ athlete_id: ATHLETE_ID, type: 'ACTIVITY_ANALYZED' }],
      }),
    });

  /** The activity intervals.icu paired with our event, with whatever note is on it there. */
  const pair = (eventId: number, description?: string) =>
    control('setup', {
      activities: [
        {
          id: 'w1',
          paired_event_id: eventId,
          start_date_local: `${DAY}T06:30:00`,
          ...(description === undefined ? {} : { description }),
        },
      ],
    });

  /** What the stand-in now holds on the activity: their side of the note. */
  const upstreamNote = async (): Promise<string | undefined> => {
    const activities = (await (
      await env.INTERVALS.fetch('https://intervals.icu/api/v1/athlete/0/activities', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
    ).json()) as Array<{ id: string; description?: string }>;
    return activities.find((activity) => activity.id === 'w1')?.description;
  };

  const comment = (planned: { date: string; id: string }, body: unknown) =>
    call(`/api/workouts/${planned.date}/${planned.id}/comment`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });

  const read = async (planned: { date: string; id: string }) =>
    (await (await call(`/api/workouts/${planned.date}/${planned.id}`)).json()) as { comment?: string };

  /** A comment written here, once the recording has come back, goes onto the activity. */
  it('writes a note onto the recorded activity upstream', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pair(event.id);
    await analysed();

    expect((await comment(planned, { comment: 'Legs flat. Cut the last two reps.' })).status).toBe(200);

    expect((await read(planned)).comment).toBe('Legs flat. Cut the last two reps.');
    expect(await upstreamNote()).toBe('Legs flat. Cut the last two reps.');
  });

  /**
   * The reason nothing is read back: a recording app writes its own line into the
   * description on upload, and that is not the athlete saying anything.
   */
  it('never adopts the description upstream as the athlete’s own note', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pair(event.id, 'Workout performed with Watchletic.');

    await analysed();

    expect((await read(planned)).comment).toBeUndefined();
    // Still readable as the platform's own text, where it is labelled as theirs.
    expect(await upstreamNote()).toBe('Workout performed with Watchletic.');
  });

  // Silence here is not an instruction to erase what the athlete has there.
  it('leaves the description alone when there is no note here', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pair(event.id, 'Typed on their site');

    await analysed();
    await analysed();

    expect(await upstreamNote()).toBe('Typed on their site');
    expect((await read(planned)).comment).toBeUndefined();
  });

  it('overwrites the description upstream with the note written here', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pair(event.id);
    await analysed();
    await comment(planned, { comment: 'Mine' });

    await pair(event.id, 'Theirs');
    await analysed();

    expect((await read(planned)).comment).toBe('Mine');
    expect(await upstreamNote()).toBe('Mine');
  });

  it('clears the note upstream as well as here', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pair(event.id);
    await analysed();
    await comment(planned, { comment: 'Said something' });

    expect(
      (await call(`/api/workouts/${planned.date}/${planned.id}/comment`, { method: 'DELETE' })).status,
    ).toBe(200);

    expect((await read(planned)).comment).toBeUndefined();
    expect(await upstreamNote()).toBe('');
  });

  /** Nothing upstream names the session until it is paired, so the note waits for one. */
  it('carries a note written before the session was paired up with the completion', async () => {
    await connect();
    const planned = await createWorkout();
    await comment(planned, { comment: 'Written the moment I stopped' });

    const [event] = await calendar();
    await pair(event.id);
    await analysed();

    expect(await upstreamNote()).toBe('Written the moment I stopped');
  });

  // The comparison is off the listing the pairing was read from, so agreement is free.
  it('sends nothing once the two agree', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pair(event.id);
    await analysed();
    await comment(planned, { comment: 'Already the same' });
    expect(await upstreamNote()).toBe('Already the same');

    const before = (await control<{ requests: Array<{ method: string }> }>('state')).requests.length;
    await analysed();
    const after = (await control<{ requests: Array<{ method: string }> }>('state')).requests;

    expect(after.slice(before).filter((request) => request.method === 'PUT')).toEqual([]);
  });

  it('carries the note across a rewrite of the plan, and onto another day', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pair(event.id);
    await analysed();
    await comment(planned, { comment: 'Survives' });

    const moved = await call(`/api/workouts/${planned.date}/${planned.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...WORKOUT, date: OTHER_DAY }),
    });
    expect(moved.status).toBe(200);

    expect((await read({ date: OTHER_DAY, id: planned.id })).comment).toBe('Survives');
  });

  it('stores the note even when the platform refuses to take it', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pair(event.id);
    await analysed();
    await control('setup', { failing: { '/activity/': 403 } });

    expect((await comment(planned, { comment: 'Stored anyway' })).status).toBe(200);
    expect((await read(planned)).comment).toBe('Stored anyway');
    expect((await platformStatus()).intervals.last_error).toContain('403');
  });

  /**
   * The grant is the thing that has to change, so the athlete is the one told. Writing
   * the description needs `ACTIVITY:WRITE`, and a token taken before this app asked for
   * it never gets one — reconnecting is the only fix, and a note re-sent hourly until
   * then is an error an hour and no progress.
   */
  it('asks once, and says so, when the grant will not take the note', async () => {
    await control('setup', { scope: 'CALENDAR:WRITE,ACTIVITY:READ' });
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pair(event.id);
    await analysed();
    await comment(planned, { comment: 'Refused upstream' });

    // The write path had its go; the pass that follows has the other.
    const before = (await control<{ requests: Array<{ method: string }> }>('state')).requests.length;
    await analysed();
    const attempted = (await control<{ requests: Array<{ method: string; path: string }> }>('state')).requests
      .slice(before)
      .filter((request) => request.method === 'PUT');
    expect(attempted).toHaveLength(1);

    expect((await platformStatus()).intervals.last_error).toContain('403');

    // And no further passes spend a call on a note that platform has already turned down.
    const spent = (await control<{ requests: Array<{ method: string }> }>('state')).requests.length;
    await analysed();
    await analysed();
    const after = (await control<{ requests: Array<{ method: string }> }>('state')).requests;
    expect(after.slice(spent).filter((request) => request.method === 'PUT')).toEqual([]);

    // The note is still the athlete's, and still here.
    expect((await read(planned)).comment).toBe('Refused upstream');
  });

  // Written off a refusal, not off a call that never arrived: their end faltering is
  // the one failure where asking again next hour is the whole of the fix.
  it('tries again after a failure the platform never answered', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pair(event.id);
    await analysed();
    await control('setup', { failing: { '/activity/': 503 } });
    await comment(planned, { comment: 'Their end fell over' });

    await control('setup', { failing: {} });
    await analysed();

    expect(await upstreamNote()).toBe('Their end fell over');
  });

  // A lap outside its band reads differently once the athlete has said why.
  it('hands the note back beside the stats of what was actually done', async () => {
    await connect();
    const planned = await createWorkout();
    const [event] = await calendar();
    await pair(event.id);
    await analysed();
    await comment(planned, { comment: 'Cut it short, calf tight' });

    const stats = (await (
      await call(`/api/workouts/${planned.date}/${planned.id}/stats`)
    ).json()) as { activity_id: string; comment: string | null };
    expect(stats.activity_id).toBe('w1');
    expect(stats.comment).toBe('Cut it short, calf tight');
  });

  it('404s a workout that is not there', async () => {
    await connect();
    expect((await comment({ date: DAY, id: 'nosuchid' }, { comment: 'hi' })).status).toBe(404);
  });
});
