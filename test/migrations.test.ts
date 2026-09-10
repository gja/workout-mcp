/**
 * The migrations themselves.
 *
 * `resetDatabase` already replays every migration before each suite, so a
 * migration that does not parse breaks the whole run. What is tested here is
 * the one that carries data: 0002 rebuilds `workouts` around a `steps` column,
 * and it has to do that without losing an already-deployed row.
 */

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import migration0002 from '../migrations/0002_workout_steps_column.sql?raw';
import { getWorkout, putWorkout } from '../src/db';
import { normalizeWorkout } from '../src/workout';
import { resetDatabase, seedUser } from './helpers';

/** The `workouts` table as it was before 0002. */
const OLD_TABLE = `
  CREATE TABLE workouts (
    user_id    TEXT NOT NULL,
    date       TEXT NOT NULL,
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    sport      TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, date, id)
  )`;

const runMigration = async (sql: string): Promise<void> => {
  for (const statement of sql.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
};

beforeEach(resetDatabase);

describe('0002, steps into their own column', () => {
  it('carries an existing row across, steps and notes intact', async () => {
    const { id: userId } = await seedUser();

    // Put the table back the way it was, with a row in the old shape.
    await env.DB.exec('DROP TABLE IF EXISTS workouts');
    await env.DB.prepare(OLD_TABLE.replace(/\s+/g, ' ')).run();

    const old = {
      version: 1,
      id: 'a1b2c3d4',
      date: '2026-09-12',
      name: '8x400m',
      sport: 'running',
      notes: 'Track session',
      steps: [{ kind: 'step', intensity: 'active', duration: { type: 'time', seconds: 600 }, target: { type: 'open' } }],
      updated_at: '2026-09-10T00:00:00.000Z',
    };
    await env.DB.prepare(
      `INSERT INTO workouts (user_id, date, id, name, sport, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(userId, old.date, old.id, old.name, old.sport, JSON.stringify(old), old.updated_at, old.updated_at)
      .run();

    await runMigration(migration0002);

    const migrated = await getWorkout(env, userId, old.date, old.id);
    expect(migrated).toMatchObject({
      id: old.id,
      date: old.date,
      name: '8x400m',
      sport: 'running',
      notes: 'Track session',
      steps: old.steps,
    });
  });

  it('leaves a workout with no notes with none', async () => {
    const { id: userId } = await seedUser();
    await env.DB.exec('DROP TABLE IF EXISTS workouts');
    await env.DB.prepare(OLD_TABLE.replace(/\s+/g, ' ')).run();

    const data = { version: 1, id: 'nonotes1', date: '2026-09-12', name: 'Easy', sport: 'running', steps: [] };
    await env.DB.prepare(
      `INSERT INTO workouts (user_id, date, id, name, sport, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '', '')`,
    )
      .bind(userId, data.date, data.id, data.name, data.sport, JSON.stringify(data))
      .run();

    await runMigration(migration0002);

    const migrated = await getWorkout(env, userId, data.date, data.id);
    expect(migrated).not.toBeNull();
    expect(migrated).not.toHaveProperty('notes');
  });
});

describe('the steps column', () => {
  it('refuses anything that is not valid JSON', async () => {
    const { id: userId } = await seedUser();
    const write = env.DB.prepare(
      `INSERT INTO workouts (user_id, date, id, name, sport, steps, created_at, updated_at)
       VALUES (?, '2026-09-12', 'bad00000', 'Bad', 'running', 'not json', '', '')`,
    ).bind(userId);

    await expect(write.run()).rejects.toThrow(/CHECK constraint failed|SQLITE_CONSTRAINT/);
  });

  it('is queryable as JSON, so the steps can be reached from SQL', async () => {
    const { id: userId } = await seedUser();
    await putWorkout(
      env,
      userId,
      normalizeWorkout({
        date: '2026-09-12',
        steps: [{ goal_s: 600 }, { repeat: 8, steps: [{ goal_meters: 400 }] }, { goal_s: 600 }],
      }),
    );

    const row = await env.DB.prepare(
      "SELECT json_array_length(steps) AS top_level, json_extract(steps, '$[1].times') AS reps FROM workouts WHERE user_id = ?",
    )
      .bind(userId)
      .first<{ top_level: number; reps: number }>();

    expect(row).toEqual({ top_level: 3, reps: 8 });
  });
});
