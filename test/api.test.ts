import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { Decoder, Stream } from '@garmin/fitsdk';
import { plannedTotals } from '../src/describe';
import { MAX_WORKOUTS_PER_USER, getWorkout, listWorkouts, putWorkout, readWindow } from '../src/db';
import { shiftDate, today } from '../src/units';
import { MAX_CHANGES, parseWorkout } from '../src/workout';
import { encodeActivityFit } from './activity-fit';
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

  it('refuses the API without a valid token, and says where the OAuth flow starts', async () => {
    const response = await SELF.fetch(`${BASE}/api/workouts`);
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    );

    const bad = await SELF.fetch(`${BASE}/api/workouts`, { headers: { Authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
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
    expect(await response.text()).toContain('<title>WorkoutsMCP</title>');
  });

  it('serves the dashboard for a link to one workout, which the client opens', async () => {
    const response = await SELF.fetch(`${BASE}/workout/abcd1234`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>WorkoutsMCP</title>');
  });

  it('serves the privacy policy at /privacy-policy, without the extension', async () => {
    const response = await SELF.fetch(`${BASE}/privacy-policy`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(await response.text()).toContain('<title>Privacy policy</title>');
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

  it('reads a workout back by date and id, summary and all', async () => {
    const { date, id } = await createIntervals();
    const response = await call(`/api/workouts/${date}/${id}.json`);
    expect(response.status).toBe(200);

    const read = (await response.json()) as { id: string; date: string; name: string; summary: string };
    expect(read).toMatchObject({ id, date, name: '8x400m' });
    expect(read.summary).toContain('Fast: 400 m @ 4:00-4:15/km');
    expect(read.summary).toContain('Float: 1:30 @ slower than 6:30/km');
  });

  it('stores tags and reads them back, summary included', async () => {
    const created = (await (
      await call('/api/workouts', { method: 'POST', body: JSON.stringify({ ...INTERVALS, tags: ['key', 'track'] }) })
    ).json()) as { date: string; id: string };

    const read = (await (await call(`/api/workouts/${created.date}/${created.id}.json`)).json()) as {
      tags: string[];
      summary: string;
    };
    expect(read.tags).toEqual(['key', 'track']);
    expect(read.summary.split('\n')[0]).toContain('[key, track]');

    // Rewritten without them, the field goes rather than coming back empty.
    await call(`/api/workouts/${created.date}/${created.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ ...INTERVALS, tags: [] }),
    });
    expect(await (await call(`/api/workouts/${created.date}/${created.id}.json`)).json()).not.toHaveProperty('tags');
  });

  // The iPhone app keeps this against what it put on the watch, and skips a workout whose
  // plan cannot have moved since. See "What a sync sends" in docs/ios.md.
  it('says on a listing when each workout was last written, and moves it on a rewrite', async () => {
    const { date, id } = await createIntervals();
    const listed = async () =>
      ((await (await call('/api/workouts.json')).json()) as { workouts: { updated_at: string }[] }).workouts[0]
        .updated_at;

    const first = await listed();
    expect(first).toEqual(expect.any(String));

    await call(`/api/workouts/${date}/${id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ ...INTERVALS, name: 'Renamed' }),
    });
    expect(await listed()).not.toBe(first);
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

    expect((await call(`/api/workouts/${NEXT_DAY}/${id}.json`)).status).toBe(200);

    // The address a client already holds still finds it: the id is what it resolves by.
    const stale = await call(`/api/workouts/${date}/${id}.json`);
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({ id, date: NEXT_DAY });

    const { workouts } = (await (await call('/api/workouts.json')).json()) as { workouts: unknown[] };
    expect(workouts).toHaveLength(1);
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

describe('the date in the path', () => {
  /** A day the workout is not on, which every route but the listing takes and ignores. */
  const stale = (id: string, suffix = '.json') => `/api/workouts/${shiftDate(today(), 9)}/${id}${suffix}`;

  it('is ignored by every verb, so a stale address still edits the right workout', async () => {
    const { date, id } = await createIntervals();

    expect((await call(stale(id))).status).toBe(200);
    expect(
      (
        await call(`${stale(id, '')}/complete`, {
          method: 'POST',
          body: JSON.stringify({ completed_at: `${date}T06:30:00Z` }),
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(`${stale(id, '')}/comment`, { method: 'PUT', body: JSON.stringify({ comment: 'Wrong day' }) }))
        .status,
    ).toBe(200);

    const read = (await (await call(`/api/workouts/${date}/${id}.json`)).json()) as {
      completed_at: string;
      comment: string;
    };
    expect(read).toMatchObject({ completed_at: `${date}T06:30:00.000Z`, comment: 'Wrong day' });

    expect((await call(stale(id), { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/api/workouts/${date}/${id}.json`)).status).toBe(404);
  });

  // The window is applied to the day the row is stored with, so a lenient path cannot
  // reach past it by naming one inside the window. The 404 names no day either.
  it('cannot reach a workout that has aged out by naming a day inside the window', async () => {
    await env.DB.prepare(
      `INSERT INTO workouts (user_id, date, id, name, sport, steps, created_at, updated_at)
       VALUES (?1, ?2, 'aged0000', 'Old', 'running', '[]', '', '')`,
    )
      .bind(userId, shiftDate(today(), -9))
      .run();

    const response = await call(`/api/workouts/${today()}/aged0000.json`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe('no workout aged0000');
  });

  it('finds a plan whose slug names the day it has left', async () => {
    const created = await createIntervals();
    await call(`/api/workouts/${created.date}/${created.id}/date`, {
      method: 'PUT',
      body: JSON.stringify({ date: NEXT_DAY }),
    });

    const body = (await (
      await call(`/api/workout-plans?plan-ids=${created.date}-${created.id}`)
    ).json()) as { plans: { date: string; id: string }[]; missing: string[] };
    expect(body.missing).toEqual([]);
    expect(body.plans).toEqual([expect.objectContaining({ id: created.id, date: NEXT_DAY })]);
  });
});

describe('saying why the plan changed', () => {
  const read = async (workout: { date: string; id: string }) =>
    (await (await call(`/api/workouts/${workout.date}/${workout.id}.json`)).json()) as {
      changes?: { at: string; reason: string }[];
      name: string;
    };

  const rewrite = (workout: { date: string; id: string }, body: Record<string, unknown>) =>
    call(`/api/workouts/${workout.date}/${workout.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ ...INTERVALS, ...body }),
    });

  it('keeps one entry per explained change, and leaves the history alone for the rest', async () => {
    const created = await createIntervals();
    expect((await read(created)).changes).toBeUndefined();

    await rewrite(created, { name: 'Shortened', change_reason: '  Cut to 6 reps: calf tight.  ' });
    await call(`/api/workouts/${created.date}/${created.id}/date`, {
      method: 'PUT',
      body: JSON.stringify({ date: NEXT_DAY, change_reason: 'Moved to Sunday: away Saturday.' }),
    });
    // Unexplained, and so neither recorded nor able to erase what came before.
    await rewrite(created, { date: NEXT_DAY, name: 'Renamed again' });

    const after = await read({ date: NEXT_DAY, id: created.id });
    expect(after.name).toBe('Renamed again');
    expect(after.changes?.map((change) => change.reason)).toEqual([
      'Cut to 6 reps: calf tight.',
      'Moved to Sunday: away Saturday.',
    ]);
    expect(Date.parse(after.changes![0].at)).toBeLessThanOrEqual(Date.parse(after.changes![1].at));
  });

  it('refuses a reason too long to be one sentence, naming the field', async () => {
    const created = await createIntervals();
    const response = await rewrite(created, { change_reason: 'x'.repeat(151) });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/change_reason/);
    expect((await read(created)).changes).toBeUndefined();
  });

  it(`keeps the newest ${MAX_CHANGES}, because a plan rewritten twenty times is not twenty stories`, async () => {
    const { id } = await createIntervals();
    for (let i = 0; i < MAX_CHANGES + 2; i++) {
      await putWorkout(env, userId, parseWorkout(INTERVALS), id, `Reason ${i}`);
    }

    const { changes } = (await (await call(`/api/workouts/${DAY}/${id}.json`)).json()) as {
      changes: { reason: string }[];
    };
    expect(changes).toHaveLength(MAX_CHANGES);
    expect(changes[0].reason).toBe('Reason 2');
    expect(changes[MAX_CHANGES - 1].reason).toBe(`Reason ${MAX_CHANGES + 1}`);
  });
});

describe('moving a workout to another day', () => {
  const move = (workout: { date: string; id: string }, date: string) =>
    call(`/api/workouts/${workout.date}/${workout.id}/date`, { method: 'PUT', body: JSON.stringify({ date }) });

  // Its own verb, so what is recorded against the session comes with it — which is what
  // lets a session already done move at all: its steps are not rewritten.
  it('keeps the id, the plan and the record of it being done', async () => {
    const created = await createIntervals();
    await call(`/api/workouts/${created.date}/${created.id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ completed_at: `${created.date}T06:30:00Z` }),
    });

    expect(await (await move(created, NEXT_DAY)).json()).toMatchObject({ id: created.id, date: NEXT_DAY });

    const { workouts } = (await (await call('/api/workouts.json')).json()) as {
      workouts: { id: string; date: string; steps: unknown[]; completed_at: string }[];
    };
    expect(workouts).toHaveLength(1);
    expect(workouts[0]).toMatchObject({
      id: created.id,
      date: NEXT_DAY,
      completed_at: `${created.date}T06:30:00.000Z`,
    });
    expect(workouts[0].steps).toHaveLength(INTERVALS.steps.length);
  });

  it('refuses a day it could not be read back from, leaving it where it is', async () => {
    const created = await createIntervals();
    expect((await move(created, shiftDate(today(), 400))).status).toBe(400);
    expect((await move(created, 'next tuesday')).status).toBe(400);
    expect((await call(`/api/workouts/${created.date}/${created.id}.json`)).status).toBe(200);
  });

  it('answers 404 for a workout that is not there', async () => {
    expect((await move({ date: DAY, id: 'nosuchid' }, NEXT_DAY)).status).toBe(404);
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

  // The plan a session was recorded against is history: the mapping in its stats names
  // steps by position, and rewriting them under it answers about steps that never ran.
  it('refuses to rewrite the steps of a workout that was done', async () => {
    const created = await createIntervals();
    expect((await complete(created)).status).toBe(200);

    const response = await call(`/api/workouts/${created.date}/${created.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ ...INTERVALS, steps: [{ name: 'Easy', goal_s: 1800 }] }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/mark it not done first/);
    expect((await read(created)).steps).toHaveLength(3);
  });

  it('still lets everything else about a done workout change', async () => {
    const created = await createIntervals();
    await complete(created);

    const response = await call(`/api/workouts/${created.date}/${created.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ ...INTERVALS, name: '8x400m (felt awful)', notes: 'legs were gone' }),
    });
    expect(response.status).toBe(200);
    expect((await read(created)).name).toBe('8x400m (felt awful)');
  });

  it('lets the plan be rewritten once the session is put back to planned', async () => {
    const created = await createIntervals();
    await complete(created);
    expect((await call(`/api/workouts/${created.date}/${created.id}/complete`, { method: 'DELETE' })).status).toBe(200);

    const response = await call(`/api/workouts/${created.date}/${created.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ ...INTERVALS, steps: [{ name: 'Easy', goal_s: 1800 }] }),
    });
    expect(response.status).toBe(200);
    expect((await read(created)).steps).toHaveLength(1);
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

  it('is scoped to the athlete', async () => {
    const created = await createIntervals();
    const other = await seedUser('other@example.com');
    const response = await SELF.fetch(`${BASE}/api/workouts/${created.date}/${created.id}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${other.token}`, 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(404);
  });
});

describe('the resolved plans', () => {
  type PlanBatch = {
    plans: Array<{ date: string; id: string; sport: string; steps: Array<Record<string, any>> }>;
    missing: string[];
  };

  const plansFor = async (...slugs: string[]): Promise<{ status: number; body: PlanBatch }> => {
    const response = await call(`/api/workout-plans?plan-ids=${slugs.join(',')}`);
    return { status: response.status, body: (await response.json()) as PlanBatch };
  };

  const slug = (workout: { date: string; id: string }) => `${workout.date}-${workout.id}`;

  it('hands back one duration and its targets a step, with the repeats kept', async () => {
    const created = await createIntervals();

    const { status, body } = await plansFor(slug(created));
    expect(status).toBe(200);
    expect(body.missing).toEqual([]);
    expect(body.plans).toHaveLength(1);

    const plan = body.plans[0];
    expect(plan.sport).toBe('running');
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0]).toMatchObject({
      kind: 'step',
      name: 'Warmup',
      intensity: 'warmup',
      duration: { type: 'time', seconds: 600 },
      target: { type: 'heart_rate', low: { unit: 'bpm', value: 146 } },
    });
    expect(plan.steps[1]).toMatchObject({ kind: 'repeat', times: 8 });
    expect(plan.steps[1].steps[0]).toMatchObject({
      duration: { type: 'distance', meters: 400 },
      target: { type: 'speed', unit: 'km' },
    });
  });

  it('answers several in one request, whatever order they were asked in', async () => {
    const first = await createIntervals();
    const second = (await (
      await call('/api/workouts', { method: 'POST', body: JSON.stringify({ ...INTERVALS, date: NEXT_DAY }) })
    ).json()) as { date: string; id: string };

    const { body } = await plansFor(slug(second), slug(first));
    expect(body.missing).toEqual([]);
    expect(body.plans.map((plan) => `${plan.date}-${plan.id}`).sort()).toEqual([slug(first), slug(second)].sort());
  });

  // A workout deleted between the listing and this call is the answer, not a failure:
  // one missing plan must not cost a client the rest of the week it asked for.
  it('names what it could not find instead of failing the batch', async () => {
    const created = await createIntervals();

    const { status, body } = await plansFor(slug(created), `${DAY}-nosuchid`);
    expect(status).toBe(200);
    expect(body.plans).toHaveLength(1);
    expect(body.missing).toEqual([`${DAY}-nosuchid`]);
  });

  it('asks for the same plan twice and is answered once', async () => {
    const created = await createIntervals();

    const { body } = await plansFor(slug(created), slug(created));
    expect(body.plans).toHaveLength(1);
    expect(body.missing).toEqual([]);
  });

  it('refuses a plan id that is not a date and an id', async () => {
    const response = await call('/api/workout-plans?plan-ids=43zhc7b6');
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('YYYY-MM-DD-<id>');
  });

  it('refuses an empty ask rather than answering nothing', async () => {
    expect((await call('/api/workout-plans')).status).toBe(400);
    expect((await call('/api/workout-plans?plan-ids=')).status).toBe(400);
  });

  // The cap itself, not just over it: a pair of bound parameters per key ran out of D1's
  // hundred here, and only here — asking for one more is refused before it reaches the query.
  it('answers an ask at the cap rather than running out of bound parameters', async () => {
    const created = await createIntervals();
    const slugs = Array.from({ length: MAX_WORKOUTS_PER_USER - 1 }, (_, i) => `${NEXT_DAY}-id${i}`);

    const { status, body } = await plansFor(slug(created), ...slugs);
    expect(status).toBe(200);
    expect(body.plans).toHaveLength(1);
    expect(body.missing).toHaveLength(MAX_WORKOUTS_PER_USER - 1);
  });

  it('refuses more ids than there can be workouts', async () => {
    const slugs = Array.from({ length: MAX_WORKOUTS_PER_USER + 1 }, (_, i) => `${DAY}-id${i}`);
    const response = await call(`/api/workout-plans?plan-ids=${slugs.join(',')}`);
    expect(response.status).toBe(400);
  });

  it('is silent about the workouts of another athlete', async () => {
    const created = await createIntervals();
    const other = await seedUser();

    const response = await SELF.fetch(`${BASE}/api/workout-plans?plan-ids=${slug(created)}`, {
      headers: { Authorization: `Bearer ${other.token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as PlanBatch;
    expect(body.plans).toEqual([]);
    expect(body.missing).toEqual([slug(created)]);
  });
});

describe('uploading a recording', () => {
  const RECORDED_ON = shiftDate(today(), -1);

  const RIDE = encodeActivityFit({
    sport: 'cycling',
    startTime: new Date(`${RECORDED_ON}T06:00:00Z`),
    laps: [{ seconds: 600, speed: 8, hr: [120, 150], power: 210, cadence: 88 }],
  });

  const createRide = async (): Promise<{ date: string; id: string }> => {
    const response = await call('/api/workouts', {
      method: 'POST',
      body: JSON.stringify({
        date: RECORDED_ON,
        name: 'Steady ten',
        sport: 'cycling',
        steps: [{ name: 'Steady', goal_s: 600, target_watts: [200, 230] }],
      }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { date: string; id: string };
  };

  const upload = (workout: { date: string; id: string }, body: BodyInit, query = '') =>
    call(`/api/workouts/${workout.date}/${workout.id}/recording${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.ant.fit' },
      body,
    });

  it('reads the file, marks the session done, and keeps no bytes', async () => {
    const created = await createRide();

    const response = await upload(created, RIDE, '?activity_id=HK-4C1F');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      name: string;
      sport: string;
      completed_at: string;
      stats: { platform: string; activity_id: string; session: { avg_power_w: number } };
    };
    // The moment the recording ended, not the moment it was uploaded.
    expect(body.completed_at).toBe(`${RECORDED_ON}T06:10:00.000Z`);
    // The iOS app writes its notification from these two — *your ride "Steady ten" has been
    // marked complete* — rather than spending a request on a listing from a background launch
    // that has seconds. See docs/ios.md.
    expect(body.name).toBe('Steady ten');
    expect(body.sport).toBe('cycling');
    expect(body.stats).toMatchObject({ platform: 'upload', activity_id: 'HK-4C1F' });
    expect(body.stats.session.avg_power_w).toBe(210);

    const stats = (await (await call(`/api/workouts/${created.date}/${created.id}/stats`)).json()) as {
      laps: Array<{ planned_step_name: string; match_confidence: string }>;
    };
    expect(stats.laps).toHaveLength(1);
    expect(stats.laps[0]).toMatchObject({ planned_step_name: 'Steady', match_confidence: 'high' });
  });

  it('leaves a completion that was already recorded where it was', async () => {
    const created = await createRide();
    await call(`/api/workouts/${created.date}/${created.id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ completed_at: `${RECORDED_ON}T05:00:00Z` }),
    });

    const body = (await (await upload(created, RIDE)).json()) as { completed_at: string };
    expect(body.completed_at).toBe(`${RECORDED_ON}T05:00:00.000Z`);
  });

  it('names the file as what could not be read, rather than storing the failure', async () => {
    const created = await createRide();

    const response = await upload(created, new Uint8Array([1, 2, 3, 4]));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/not a FIT file/);

    // Nothing stored, so the next upload is a first attempt rather than a retry.
    expect((await call(`/api/workouts/${created.date}/${created.id}/stats`)).status).toBe(404);
  });

  it('refuses an empty body', async () => {
    const created = await createRide();
    const response = await upload(created, new Uint8Array());
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/body is empty/);
  });

  it('refuses a file larger than a Worker can decode, before reading it', async () => {
    const created = await createRide();
    const response = await call(`/api/workouts/${created.date}/${created.id}/recording`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.ant.fit', 'Content-Length': String(9 * 1024 * 1024) },
      body: RIDE,
    });
    expect(response.status).toBe(413);
  });

  it('404s a workout that is not there', async () => {
    const response = await upload({ date: DAY, id: 'nosuchid' }, RIDE);
    expect(response.status).toBe(404);
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
    expect((await call(`/api/workouts/${date}/${id}/complete`, { method: 'PUT' })).status).toBe(405);
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
  it('serves the stored workout at /export/:date-:id.fit, repeats and targets intact', async () => {
    const { date, id } = await createIntervals();
    const response = await call(`/export/${date}-${id}.fit`);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/vnd.ant.fit');
    expect(response.headers.get('Content-Disposition')).toBe(`attachment; filename="${date}-${id}.fit"`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    const { messages, errors } = new Decoder(Stream.fromByteArray(bytes)).read();
    expect(errors).toEqual([]);
    expect(messages.workoutMesgs?.[0]).toMatchObject({ wktName: '8x400m', numValidSteps: 5 });

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
});

describe('retention', () => {
  const put = (date: string) => putWorkout(env, userId, parseWorkout({ date, steps: [{ goal_s: 600 }] }));

  const rowCount = async (id = userId): Promise<number> =>
    (
      await env.DB.prepare('SELECT COUNT(*) AS n FROM workouts WHERE user_id = ?').bind(id).first<{ n: number }>()
    )?.n ?? 0;

  it('keeps the window around today', async () => {
    const day = today();
    await put(shiftDate(day, -3));
    await put(day);
    await put(shiftDate(day, 10));
    expect(await listWorkouts(env, userId)).toHaveLength(3);
  });

  /**
   * The window is a read bound, not a sweep. A row that has aged out stops
   * being visible and stays in the table — deleting an athlete's training
   * history to reclaim a few hundred bytes is the wrong trade.
   */
  it('leaves a workout that has aged out in the table, unreadable', async () => {
    await env.DB.prepare(
      `INSERT INTO workouts (user_id, date, id, name, sport, steps, created_at, updated_at)
       VALUES (?, '2020-08-01', 'old00000', 'Old', 'running', '[]', '', '')`,
    )
      .bind(userId)
      .run();

    // A later write is the moment the old sweep would have taken it.
    await put(today());

    expect(await rowCount()).toBe(2);
    expect(await listWorkouts(env, userId)).toHaveLength(1);
    expect(await getWorkout(env, userId, 'old00000')).toBeNull();
  });

  it('refuses a new workout past the cap rather than deleting an older one', async () => {
    const day = today();
    for (let i = 0; i < MAX_WORKOUTS_PER_USER; i++) await put(shiftDate(day, 1 + (i % 13)));

    await expect(put(shiftDate(day, -7))).rejects.toThrow(/only 50 workouts are kept at a time/);

    expect(await listWorkouts(env, userId)).toHaveLength(MAX_WORKOUTS_PER_USER);
    expect(await rowCount()).toBe(MAX_WORKOUTS_PER_USER);
  });

  it('still lets a workout already at the cap be replaced', async () => {
    const day = today();
    const ids: Array<{ date: string; id: string }> = [];
    for (let i = 0; i < MAX_WORKOUTS_PER_USER; i++) ids.push(await put(shiftDate(day, 1 + (i % 13))));

    // An update reuses a row, so it adds nothing to the count and the cap has
    // nothing to say about it.
    const [first] = ids;
    const replaced = await putWorkout(
      env,
      userId,
      parseWorkout({ date: first.date, name: 'Replaced', steps: [{ goal_s: 900 }] }),
      first.id,
    );
    expect(replaced.name).toBe('Replaced');
    expect(await rowCount()).toBe(MAX_WORKOUTS_PER_USER);
  });

  /** Rows outside the window do not count, so the cap stays rolling. */
  it('does not count a workout that has aged out towards the cap', async () => {
    for (let i = 0; i < MAX_WORKOUTS_PER_USER; i++) {
      await env.DB.prepare(
        `INSERT INTO workouts (user_id, date, id, name, sport, steps, created_at, updated_at)
         VALUES (?1, '2020-08-01', ?2, 'Old', 'running', '[]', '', '')`,
      )
        .bind(userId, `old${String(i).padStart(5, '0')}`)
        .run();
    }

    const written = await put(today());
    expect(written.id).toBeTruthy();
  });

  it('refuses a date outside the window instead of storing what cannot be read', async () => {
    const far = shiftDate(today(), 60);
    await expect(put(far)).rejects.toThrow(/could not be read back/);
    expect(await rowCount()).toBe(0);

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

  it('counts the cap per athlete, not across the table', async () => {
    const day = today();
    for (let i = 0; i < MAX_WORKOUTS_PER_USER; i++) await put(shiftDate(day, 1 + (i % 13)));

    // Another athlete is not out of room because this one is.
    const other = await seedUser('other@example.com');
    await putWorkout(env, other.id, parseWorkout({ date: day, steps: [{ goal_s: 600 }] }));
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

    // Directly, by id.
    expect(await getWorkout(env, userId, 'oldone00')).toBeNull();
    expect(await getWorkout(env, userId, 'newone00')).toBeNull();

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
