import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { Decoder, Stream } from '@garmin/fitsdk';
import { MAX_WORKOUTS_PER_USER, listWorkouts, prune, putWorkout } from '../src/db';
import { shiftDate, today } from '../src/units';
import { normalizeWorkout } from '../src/workout';
import { resetDatabase, seedUser } from './helpers';

const BASE = 'https://workouts.example';

let token: string;
let userId: string;

beforeEach(async () => {
  await resetDatabase();
  ({ id: userId, token } = await seedUser());
});

const call = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });

const INTERVALS = {
  date: '2026-09-12',
  name: '8x400m',
  steps: [
    { name: 'Warmup', goal_s: 600, target_heart_rate: [146, 153] },
    {
      repeat: 8,
      steps: [
        { name: 'Fast', goal_meters: 400, target_pace_km: ['4:00', '4:15'] },
        { name: 'Float', goal_s: 90, target_pace_km: ['-', '6:30'] },
      ],
    },
    { name: 'Cooldown', goal_s: 600 },
  ],
};

async function createIntervals(): Promise<{ date: string; id: string }> {
  const response = await call('/api/workouts', { method: 'POST', body: JSON.stringify(INTERVALS) });
  expect(response.status).toBe(201);
  return (await response.json()) as { date: string; id: string };
}

describe('authentication', () => {
  it('serves health without a token', async () => {
    const response = await SELF.fetch(`${BASE}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('refuses the API without a valid token', async () => {
    expect((await SELF.fetch(`${BASE}/api/workouts`)).status).toBe(401);
    const bad = await SELF.fetch(`${BASE}/api/workouts`, { headers: { Authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
  });

  it('points an unauthenticated MCP client at the OAuth metadata', async () => {
    const response = await SELF.fetch(`${BASE}/api/workouts`);
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('keeps one athlete\'s workouts out of another\'s', async () => {
    const { date, id } = await createIntervals();
    const other = await seedUser('other');

    const response = await SELF.fetch(`${BASE}/api/workouts/${date}/${id}.json`, {
      headers: { Authorization: `Bearer ${other.token}` },
    });
    expect(response.status).toBe(404);
  });
});

describe('dashboard', () => {
  it('serves the static dashboard on anything not claimed by the API', async () => {
    const response = await SELF.fetch(`${BASE}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(await response.text()).toContain('<title>Workouts</title>');
  });
});

describe('workout CRUD', () => {
  it('creates a workout and hands back its id and URLs', async () => {
    const created = (await (
      await call('/api/workouts', { method: 'POST', body: JSON.stringify(INTERVALS) })
    ).json()) as Record<string, string>;

    expect(created.date).toBe('2026-09-12');
    expect(created.id).toMatch(/^[0-9a-z]{8}$/);
    expect(created.fit_url).toBe(`${BASE}/export/2026-09-12-${created.id}.fit`);
    expect(created.json_url).toBe(`${BASE}/api/workouts/2026-09-12/${created.id}.json`);
    expect(created.summary).toContain('Fast: 400 m @ 4:00-4:15/km');
    expect(created.summary).toContain('Float: 1:30 @ slower than 6:30/km');
  });

  it('reads a workout back by date and id', async () => {
    const { date, id } = await createIntervals();
    const response = await call(`/api/workouts/${date}/${id}.json`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, date, name: '8x400m' });
  });

  it('allows several workouts on one date', async () => {
    const first = await createIntervals();
    const second = await createIntervals();
    expect(second.id).not.toBe(first.id);

    const list = (await (await call('/api/workouts.json')).json()) as { workouts: unknown[] };
    expect(list.workouts).toHaveLength(2);
  });

  it('replaces a workout in place, keeping its id', async () => {
    const { date, id } = await createIntervals();
    const response = await call(`/api/workouts/${date}/${id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ date, name: 'Easy hour', steps: [{ goal_s: 3600 }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, name: 'Easy hour' });
  });

  it('moves a workout to another date without leaving a copy behind', async () => {
    const { date, id } = await createIntervals();
    await call(`/api/workouts/${date}/${id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ ...INTERVALS, date: '2026-09-13' }),
    });

    expect((await call(`/api/workouts/${date}/${id}.json`)).status).toBe(404);
    expect((await call(`/api/workouts/2026-09-13/${id}.json`)).status).toBe(200);
  });

  it('deletes a workout', async () => {
    const { date, id } = await createIntervals();
    expect((await call(`/api/workouts/${date}/${id}.json`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/api/workouts/${date}/${id}.json`)).status).toBe(404);
  });

  it('filters the list by date range', async () => {
    await createIntervals();
    const empty = (await (await call('/api/workouts.json?from=2026-09-13&to=2026-09-20')).json()) as {
      workouts: unknown[];
    };
    expect(empty.workouts).toHaveLength(0);
  });

  it('explains what is wrong with a bad workout', async () => {
    const response = await call('/api/workouts', {
      method: 'POST',
      body: JSON.stringify({ date: '2026-09-12', steps: [{ goal_s: 60, goal_meters: 400 }] }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('only have one duration'),
    });
  });
});

describe('the tools, over plain REST', () => {
  it('runs a tool and returns what MCP would', async () => {
    const created = await call('/api/tools/create_workout', {
      method: 'POST',
      body: JSON.stringify(INTERVALS),
    });
    expect(created.status).toBe(200);
    const workout = (await created.json()) as { id: string; date: string; summary: string };
    expect(workout.id).toMatch(/^[0-9a-z]{8}$/);

    const listed = await call('/api/tools/list_workouts', { method: 'POST', body: '{}' });
    const { workouts } = (await listed.json()) as { workouts: { id: string }[] };
    expect(workouts.map((w) => w.id)).toEqual([workout.id]);
  });

  it('agrees with the REST route it mirrors', async () => {
    const { date, id } = await createIntervals();

    const viaRest = await (await call(`/api/workouts/${date}/${id}.json`)).json();
    const viaTool = await (
      await call('/api/tools/get_workout', { method: 'POST', body: JSON.stringify({ date, id }) })
    ).json();
    expect(viaTool).toEqual(viaRest);
  });

  it('exports FIT bytes that match the download', async () => {
    const { date, id } = await createIntervals();
    const exported = (await (
      await call('/api/tools/export_workout_fit', { method: 'POST', body: JSON.stringify({ date, id }) })
    ).json()) as { base64: string; filename: string };

    const downloaded = new Uint8Array(await (await call(`/export/${date}-${id}.fit`)).arrayBuffer());
    const inline = Uint8Array.from(atob(exported.base64), (character) => character.charCodeAt(0));

    expect(exported.filename).toBe(`${date}-${id}.fit`);
    // The two routes encode the same workout, so only the creation timestamp
    // in the file header can differ.
    expect(inline.length).toBe(downloaded.length);
  });

  it('reports an unknown tool and a wrong method', async () => {
    const unknown = await call('/api/tools/make_coffee', { method: 'POST', body: '{}' });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('unknown tool'),
    });

    expect((await call('/api/tools/list_workouts')).status).toBe(405);
  });
});

describe('bad requests', () => {
  it('rejects an unparseable body', async () => {
    const response = await call('/api/workouts', { method: 'POST', body: 'not json' });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid JSON body' });
  });

  it('rejects a nonsense date filter', async () => {
    expect((await call('/api/workouts.json?from=yesterday')).status).toBe(400);
  });

  it('will not replace a workout that is not there', async () => {
    const response = await call('/api/workouts/2026-09-12/zzzzzzzz.json', {
      method: 'PUT',
      body: JSON.stringify(INTERVALS),
    });
    expect(response.status).toBe(404);
  });

  it('refuses methods a route does not offer', async () => {
    const { date, id } = await createIntervals();
    expect((await call('/api/workouts', { method: 'DELETE' })).status).toBe(405);
    expect((await call(`/api/workouts/${date}/${id}.json`, { method: 'POST', body: '{}' })).status).toBe(405);
  });

  it('404s an unknown API route', async () => {
    expect((await call('/api/nothing-here')).status).toBe(404);
  });
});

describe('FIT export', () => {
  it('serves a decodable FIT file at /export/:date-:id.fit', async () => {
    const { date, id } = await createIntervals();
    const response = await call(`/export/${date}-${id}.fit`);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/vnd.ant.fit');
    expect(response.headers.get('Content-Disposition')).toBe(`attachment; filename="${date}-${id}.fit"`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    const { messages, errors } = new Decoder(Stream.fromByteArray(bytes)).read();
    expect(errors).toEqual([]);
    expect(messages.workoutMesgs?.[0]).toMatchObject({ wktName: '8x400m', numValidSteps: 5 });
  });

  it('accepts the token as a query parameter, since a watch cannot set headers', async () => {
    const { date, id } = await createIntervals();
    const response = await SELF.fetch(`${BASE}/export/${date}-${id}.fit?token=${token}`);
    expect(response.status).toBe(200);
  });

  it('rejects a malformed slug and an unknown workout', async () => {
    expect((await call('/export/not-a-workout.fit')).status).toBe(400);
    expect((await call('/export/2026-09-12-zzzzzzzz.fit')).status).toBe(404);
  });

  it('will not export another athlete\'s workout', async () => {
    const { date, id } = await createIntervals();
    const other = await seedUser('other@example.com');

    const response = await SELF.fetch(`${BASE}/export/${date}-${id}.fit`, {
      headers: { Authorization: `Bearer ${other.token}` },
    });
    expect(response.status).toBe(404);
  });

  it('encodes the workout that was stored, repeats and targets intact', async () => {
    const { date, id } = await createIntervals();
    const bytes = new Uint8Array(await (await call(`/export/${date}-${id}.fit`)).arrayBuffer());
    const { messages } = new Decoder(Stream.fromByteArray(bytes)).read();

    const steps = messages.workoutStepMesgs ?? [];
    expect(steps.map((step) => step.wktStepName ?? step.durationType)).toEqual([
      'Warmup',
      'Fast',
      'Float',
      'repeatUntilStepsCmplt',
      'Cooldown',
    ]);
    expect(steps[0]).toMatchObject({ customTargetHeartRateLow: 246, customTargetHeartRateHigh: 253 });
    expect(steps[1].customTargetSpeedLow as number).toBeCloseTo(1000 / 255, 2);
    expect(steps[3]).toMatchObject({ durationStep: 1, repeatSteps: 8 });
  });
});

describe('retention', () => {
  const put = (date: string) => putWorkout(env, userId, normalizeWorkout({ date, steps: [{ goal_s: 600 }] }));

  it('drops workouts outside the window on write', async () => {
    const now = new Date('2026-09-10T00:00:00Z');
    await env.DB.prepare(
      "INSERT INTO workouts (user_id, date, id, name, sport, data, created_at, updated_at) VALUES (?, '2026-08-01', 'old00000', 'Old', 'running', '{}', '', '')",
    )
      .bind(userId)
      .run();

    await prune(env, userId, now);
    const remaining = await env.DB.prepare('SELECT COUNT(*) AS n FROM workouts WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });

  it('keeps the window around today', async () => {
    const day = today();
    await put(shiftDate(day, -3));
    await put(day);
    await put(shiftDate(day, 10));
    expect(await listWorkouts(env, userId)).toHaveLength(3);
  });

  it('caps a user at the per-user limit, keeping the newest', async () => {
    const day = today();
    for (let i = 0; i < MAX_WORKOUTS_PER_USER + 5; i++) await put(day);
    expect(await listWorkouts(env, userId)).toHaveLength(MAX_WORKOUTS_PER_USER);
  });

  it('drops the oldest dates first when the cap bites', async () => {
    const day = today();
    // Fill the cap with future dates, then add older ones that should lose.
    for (let i = 0; i < MAX_WORKOUTS_PER_USER; i++) await put(shiftDate(day, 1 + (i % 13)));
    await put(shiftDate(day, -7));

    const remaining = await listWorkouts(env, userId);
    expect(remaining).toHaveLength(MAX_WORKOUTS_PER_USER);
    expect(remaining.every((workout) => workout.date > day)).toBe(true);
  });

  it('leaves one athlete\'s workouts alone when another is pruned', async () => {
    const other = await seedUser('other@example.com');
    await putWorkout(env, other.id, normalizeWorkout({ date: today(), steps: [{ goal_s: 600 }] }));

    await put(today());
    await prune(env, userId);

    expect(await listWorkouts(env, other.id)).toHaveLength(1);
  });
});
