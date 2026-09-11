import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { Decoder, Stream } from '@garmin/fitsdk';
import { plannedTotals } from '../src/describe';
import { MAX_WORKOUTS_PER_USER, getWorkout, listWorkouts, prune, putWorkout, readWindow } from '../src/db';
import { shiftDate, today } from '../src/units';
import { parseWorkout } from '../src/workout';
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

/**
 * Fixture dates are relative to today, not written down: a workout only exists
 * inside the retention window, so a literal date would quietly fall out of it
 * as real time moved past and take the suite with it.
 */
const DAY = shiftDate(today(), 2);
const NEXT_DAY = shiftDate(today(), 3);

const INTERVALS = {
  date: DAY,
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
  it('creates a workout and hands back its id and URLs, not its steps', async () => {
    const created = (await (
      await call('/api/workouts', { method: 'POST', body: JSON.stringify(INTERVALS) })
    ).json()) as Record<string, unknown>;

    expect(created.date).toBe(DAY);
    expect(created.id).toMatch(/^[0-9a-z]{8}$/);
    expect(created.name).toBe('8x400m');
    expect(created.fit_url).toBe(`${BASE}/export/${DAY}-${created.id as string}.fit`);
    expect(created.json_url).toBe(`${BASE}/api/workouts/${DAY}/${created.id as string}.json`);

    // A write says which workout it was, not what the caller just sent.
    expect(created).not.toHaveProperty('steps');
    expect(created).not.toHaveProperty('summary');
    expect(created).not.toHaveProperty('planned');
  });

  it('stores the steps exactly as they were written', async () => {
    const { date, id } = await createIntervals();
    const read = (await (await call(`/api/workouts/${date}/${id}.json`)).json()) as { steps: unknown[] };

    // No `kind`, no `duration: { type }`, no speeds in metres per second —
    // the caller's own fields come back.
    expect(read.steps).toEqual(INTERVALS.steps);
  });

  it('keeps a workout readable after a round trip through the database', async () => {
    const { date, id } = await createIntervals();
    const read = (await (await call(`/api/workouts/${date}/${id}.json`)).json()) as {
      summary: string;
      planned: { seconds: number };
    };

    expect(read.summary).toContain('Fast: 400 m @ 4:00-4:15/km');
    expect(read.summary).toContain('Float: 1:30 @ slower than 6:30/km');
    expect(read.planned.seconds).toBe(600 + 8 * 90 + 600);
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
      body: JSON.stringify({ ...INTERVALS, date: NEXT_DAY }),
    });

    expect((await call(`/api/workouts/${date}/${id}.json`)).status).toBe(404);
    expect((await call(`/api/workouts/${NEXT_DAY}/${id}.json`)).status).toBe(200);
  });

  it('deletes a workout', async () => {
    const { date, id } = await createIntervals();
    expect((await call(`/api/workouts/${date}/${id}.json`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/api/workouts/${date}/${id}.json`)).status).toBe(404);
  });

  it('filters the list by date range', async () => {
    await createIntervals();
    const empty = (await (await call(`/api/workouts.json?from=${NEXT_DAY}&to=${shiftDate(today(), 10)}`)).json()) as {
      workouts: unknown[];
    };
    expect(empty.workouts).toHaveLength(0);
  });

  it('explains what is wrong with a bad workout', async () => {
    const response = await call('/api/workouts', {
      method: 'POST',
      body: JSON.stringify({ date: DAY, steps: [{ goal_s: 60, goal_meters: 400 }] }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('only have one duration'),
    });
  });
});

describe('planned totals', () => {
  it('resolves repeats and reports what cannot be counted', () => {
    const totals = plannedTotals(
      parseWorkout({
        date: '2026-09-12',
        steps: [
          { name: 'Warmup', goal_s: 600 },
          { repeat: 8, steps: [{ goal_meters: 400 }, { goal_s: 90 }] },
          { name: 'Cooldown' },
        ],
      }).steps,
    );

    // 600s warmup + 8x90s float; 8x400m; the cooldown runs to a lap press.
    expect(totals).toEqual({ seconds: 600 + 8 * 90, meters: 3200, steps: 18, open_steps: 1 });
  });

  it('multiplies through nested repeats', () => {
    const totals = plannedTotals(
      parseWorkout({
        date: '2026-09-12',
        steps: [{ repeat: 3, steps: [{ repeat: 4, steps: [{ goal_s: 30 }] }] }],
      }).steps,
    );
    expect(totals).toMatchObject({ seconds: 3 * 4 * 30, steps: 12, open_steps: 0 });
  });

  it('rides along on every workout a read returns', async () => {
    const { date, id } = await createIntervals();
    const read = (await (await call(`/api/workouts/${date}/${id}.json`)).json()) as {
      planned: { seconds: number; meters: number; open_steps: number };
    };

    // 600s warmup + 8x90s float, 8x400m, and a 600s cooldown.
    expect(read.planned).toEqual({ seconds: 600 + 8 * 90 + 600, meters: 3200, steps: 18, open_steps: 0 });
  });
});

describe('an external id', () => {
  const withKey = (extra: Record<string, unknown> = {}) =>
    call('/api/workouts', {
      method: 'POST',
      body: JSON.stringify({ ...INTERVALS, external_id: 'watchletic-8891', ...extra }),
    });

  it('updates the same workout instead of duplicating it', async () => {
    const first = (await (await withKey()).json()) as { id: string };
    const again = (await (await withKey({ name: 'Renamed' })).json()) as { id: string; name: string };

    expect(again.id).toBe(first.id);
    expect(again.name).toBe('Renamed');

    const { workouts } = (await (await call('/api/workouts.json')).json()) as { workouts: unknown[] };
    expect(workouts).toHaveLength(1);
  });

  it('moves the workout when the plan moves it, without leaving a copy', async () => {
    const first = (await (await withKey()).json()) as { id: string; date: string };
    const moved = (await (await withKey({ date: NEXT_DAY })).json()) as { id: string; date: string };

    expect(moved.id).toBe(first.id);
    expect(moved.date).toBe(NEXT_DAY);

    const { workouts } = (await (await call('/api/workouts.json')).json()) as { workouts: { date: string }[] };
    expect(workouts.map((w) => w.date)).toEqual([NEXT_DAY]);
  });

  it('keeps workouts without a key independent', async () => {
    await createIntervals();
    await createIntervals();
    const { workouts } = (await (await call('/api/workouts.json')).json()) as { workouts: unknown[] };
    expect(workouts).toHaveLength(2);
  });

  it('is scoped to the athlete', async () => {
    await withKey();
    const other = await seedUser('other@example.com');
    const response = await SELF.fetch(`${BASE}/api/workouts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${other.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...INTERVALS, external_id: 'watchletic-8891' }),
    });
    expect(response.status).toBe(201);
  });
});

describe('completing a workout', () => {
  const complete = (workout: { date: string; id: string }, body?: unknown) =>
    call(`/api/workouts/${workout.date}/${workout.id}/complete`, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const read = async (workout: { date: string; id: string }) =>
    (await (await call(`/api/workouts/${workout.date}/${workout.id}.json`)).json()) as {
      completed_at?: string;
      name: string;
      steps: unknown[];
    };

  it('records the time it was done, defaulting to now', async () => {
    const created = await createIntervals();
    const before = Date.now();

    const response = await complete(created);
    expect(response.status).toBe(200);
    const { completed_at: completedAt } = (await response.json()) as { completed_at: string };

    expect(Date.parse(completedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(completedAt)).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await read(created)).completed_at).toBe(completedAt);
  });

  it('takes a time of its own, for a session logged after the fact', async () => {
    const created = await createIntervals();
    await complete(created, { completed_at: `${created.date}T06:30:00Z` });
    expect((await read(created)).completed_at).toBe(`${created.date}T06:30:00.000Z`);
  });

  it('reads a bare date as the start of that day', async () => {
    const created = await createIntervals();
    await complete(created, { completed_at: created.date });
    expect((await read(created)).completed_at).toBe(`${created.date}T00:00:00.000Z`);
  });

  it('refuses a timestamp that is not one', async () => {
    const created = await createIntervals();
    const response = await complete(created, { completed_at: 'yesterday afternoon' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/completed_at/);
  });

  it('clears the record on a DELETE, leaving the plan alone', async () => {
    const created = await createIntervals();
    await complete(created);

    const response = await call(`/api/workouts/${created.date}/${created.id}/complete`, { method: 'DELETE' });
    expect(response.status).toBe(200);

    const after = await read(created);
    expect(after).not.toHaveProperty('completed_at');
    expect(after.steps).toHaveLength(3);
  });

  it('is idempotent, and the last time given wins', async () => {
    const created = await createIntervals();
    await complete(created, { completed_at: `${created.date}T06:30:00Z` });
    await complete(created, { completed_at: `${created.date}T18:00:00Z` });
    expect((await read(created)).completed_at).toBe(`${created.date}T18:00:00.000Z`);
  });

  it('404s for a workout that is not there', async () => {
    const response = await complete({ date: DAY, id: 'nosuchid1' });
    expect(response.status).toBe(404);
  });

  it('is scoped to the athlete', async () => {
    const created = await createIntervals();
    const other = await seedUser('other@example.com');
    const response = await SELF.fetch(`${BASE}/api/workouts/${created.date}/${created.id}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${other.token}`, 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(404);
  });

  it('survives a rewrite of the plan, and a move to another day', async () => {
    const created = await createIntervals();
    await complete(created, { completed_at: `${created.date}T06:30:00Z` });

    const replaced = await call(`/api/workouts/${created.date}/${created.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ ...INTERVALS, name: 'Renamed', date: NEXT_DAY }),
    });
    expect(replaced.status).toBe(200);

    const moved = await read({ date: NEXT_DAY, id: created.id });
    expect(moved.name).toBe('Renamed');
    expect(moved.completed_at).toBe(`${created.date}T06:30:00.000Z`);
  });

  it('survives a re-sync under the same external id', async () => {
    const first = (await (await call('/api/workouts', {
      method: 'POST',
      body: JSON.stringify({ ...INTERVALS, external_id: 'plan-7' }),
    })).json()) as { id: string; date: string };
    await complete(first, { completed_at: `${first.date}T06:30:00Z` });

    await call('/api/workouts', {
      method: 'POST',
      body: JSON.stringify({ ...INTERVALS, external_id: 'plan-7', date: NEXT_DAY }),
    });

    const after = await read({ date: NEXT_DAY, id: first.id });
    expect(after.completed_at).toBe(`${first.date}T06:30:00.000Z`);
  });

  it('refuses a method it does not have', async () => {
    const created = await createIntervals();
    const response = await call(`/api/workouts/${created.date}/${created.id}/complete`, { method: 'PUT' });
    expect(response.status).toBe(405);
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

    const viaRest = (await (await call(`/api/workouts/${date}/${id}.json`)).json()) as Record<string, unknown>;
    const viaTool = await (
      await call('/api/tools/get_workout', { method: 'POST', body: JSON.stringify({ date, id }) })
    ).json();

    // The tool surface is the same workout without the links: those are for
    // the dashboard, which can actually follow them.
    const { fit_url: _fit, json_url: _json, ...withoutLinks } = viaRest;
    expect(viaRest.fit_url).toBeTruthy();
    expect(viaTool).toEqual(withoutLinks);
  });

  it('exports FIT bytes that match the download', async () => {
    const { date, id } = await createIntervals();
    const exported = (await (
      await call('/api/tools/export_workout_fit', { method: 'POST', body: JSON.stringify({ date, id }) })
    ).json()) as { base64: string; filename: string };

    const downloaded = new Uint8Array(await (await call(`/export/${date}-${id}.fit`)).arrayBuffer());
    const inline = Uint8Array.from(atob(exported.base64), (character) => character.charCodeAt(0));

    expect(exported.filename).toBe(`${date}-8x400m.fit`);
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
    const response = await call(`/api/workouts/${DAY}/zzzzzzzz.json`, {
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

  it('will not let a caller without a credential tell a real route from a made-up one', async () => {
    // Both 401, so status codes cannot be read as a map of the API.
    expect((await SELF.fetch(`${BASE}/api/me`, { method: 'DELETE' })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/nothing-here`, { method: 'DELETE' })).status).toBe(401);
  });

  it('answers HEAD wherever it answers GET', async () => {
    const { date, id } = await createIntervals();
    expect((await SELF.fetch(`${BASE}/api/health`, { method: 'HEAD' })).status).toBe(200);
    expect((await call('/api/me', { method: 'HEAD' })).status).toBe(200);
    expect((await call(`/export/${date}-${id}.fit`, { method: 'HEAD' })).status).toBe(200);
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
    expect((await call(`/export/${DAY}-zzzzzzzz.fit`)).status).toBe(404);
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
  const put = (date: string) => putWorkout(env, userId, parseWorkout({ date, steps: [{ goal_s: 600 }] }));

  it('drops workouts outside the window on write', async () => {
    const now = new Date('2026-09-10T00:00:00Z');
    await env.DB.prepare(
      `INSERT INTO workouts (user_id, date, id, name, sport, steps, created_at, updated_at)
       VALUES (?, '2026-08-01', 'old00000', 'Old', 'running', '[]', '', '')`,
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

  it('refuses a write the cap would drop, rather than losing it quietly', async () => {
    const day = today();
    // Fill the cap with future dates, then add an older one that should lose.
    for (let i = 0; i < MAX_WORKOUTS_PER_USER; i++) await put(shiftDate(day, 1 + (i % 13)));

    await expect(put(shiftDate(day, -7))).rejects.toThrow(/only 50 workouts are kept/);

    const remaining = await listWorkouts(env, userId);
    expect(remaining).toHaveLength(MAX_WORKOUTS_PER_USER);
    expect(remaining.every((workout) => workout.date > day)).toBe(true);
  });

  it('refuses a date outside the window instead of pruning it on the way in', async () => {
    const far = shiftDate(today(), 60);
    await expect(put(far)).rejects.toThrow(/would be dropped straight away/);

    const response = await call('/api/workouts', {
      method: 'POST',
      body: JSON.stringify({ ...INTERVALS, date: far }),
    });
    expect(response.status).toBe(400);
  });

  it('reports an external_id that already belongs to another workout', async () => {
    const first = (await (await call('/api/workouts', {
      method: 'POST',
      body: JSON.stringify({ ...INTERVALS, external_id: 'taken' }),
    })).json()) as { id: string };

    const second = (await (await call('/api/workouts', {
      method: 'POST',
      body: JSON.stringify({ ...INTERVALS, external_id: 'free' }),
    })).json()) as { date: string; id: string };

    const response = await call(`/api/workouts/${second.date}/${second.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...INTERVALS, external_id: 'taken' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining(first.id) });
  });

  it('leaves one athlete\'s workouts alone when another is pruned', async () => {
    const other = await seedUser('other@example.com');
    await putWorkout(env, other.id, parseWorkout({ date: today(), steps: [{ goal_s: 600 }] }));

    await put(today());
    await prune(env, userId);

    expect(await listWorkouts(env, other.id)).toHaveLength(1);
  });
});

describe('the read window', () => {
  /** A row the sweep has not caught yet, written straight past the API. */
  const stow = async (date: string, id: string) => {
    await env.DB.prepare(
      `INSERT INTO workouts (user_id, date, id, name, sport, steps, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Stale', 'running', '[]', ?4, ?4)`,
    )
      .bind(userId, date, id, new Date().toISOString())
      .run();
  };

  it('allows a day of slack on each side of what is kept', () => {
    const day = today();
    expect(readWindow()).toEqual({ from: shiftDate(day, -8), to: shiftDate(day, 15) });
  });

  it('will not read a workout outside the window, however it is asked for', async () => {
    const before = shiftDate(today(), -9);
    const after = shiftDate(today(), 16);
    await stow(before, 'oldone00');
    await stow(after, 'newone00');

    // Directly, by date and id.
    expect(await getWorkout(env, userId, before, 'oldone00')).toBeNull();
    expect(await getWorkout(env, userId, after, 'newone00')).toBeNull();

    // Through the API, and as a FIT download.
    expect((await call(`/api/workouts/${before}/oldone00.json`)).status).toBe(404);
    expect((await call(`/export/${after}-newone00.fit`)).status).toBe(404);
  });

  it('narrows a from/to that reaches past the window rather than obeying it', async () => {
    await stow(shiftDate(today(), -9), 'oldone00');
    await stow(shiftDate(today(), 16), 'newone00');
    await putWorkout(env, userId, parseWorkout({ date: today(), steps: [{ goal_s: 600 }] }));

    const listed = await listWorkouts(env, userId, '2000-01-01', '2100-01-01');
    expect(listed.map((workout) => workout.date)).toEqual([today()]);

    const response = await call('/api/workouts.json?from=2000-01-01&to=2100-01-01');
    const { workouts } = (await response.json()) as { workouts: { date: string }[] };
    expect(workouts.map((workout) => workout.date)).toEqual([today()]);
  });

  it('still narrows a from/to that asks for less', async () => {
    const day = today();
    await putWorkout(env, userId, parseWorkout({ date: day, steps: [{ goal_s: 600 }] }));
    await putWorkout(env, userId, parseWorkout({ date: shiftDate(day, 5), steps: [{ goal_s: 600 }] }));

    const listed = await listWorkouts(env, userId, day, day);
    expect(listed.map((workout) => workout.date)).toEqual([day]);
  });
});
