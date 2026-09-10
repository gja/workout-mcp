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
import migration0003 from '../migrations/0003_sub_sport_and_external_id.sql?raw';
import { getWorkout, putWorkout } from '../src/db';
import { parseWorkout } from '../src/workout';
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
    await runMigration(migration0003);

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
    await runMigration(migration0003);

    const migrated = await getWorkout(env, userId, data.date, data.id);
    expect(migrated).not.toBeNull();
    expect(migrated).not.toHaveProperty('notes');
  });
});

describe('0003, sub-sport and external id', () => {
  it('keeps an external id unique per athlete, and only when set', async () => {
    const { id: userId } = await seedUser();
    const insert = (id: string, externalId: string | null) =>
      env.DB.prepare(
        `INSERT INTO workouts (user_id, date, id, name, sport, steps, external_id, created_at, updated_at)
         VALUES (?, '2026-09-12', ?, 'W', 'running', '[]', ?, '', '')`,
      )
        .bind(userId, id, externalId)
        .run();

    await insert('aaaaaaaa', 'plan-1');
    await expect(insert('bbbbbbbb', 'plan-1')).rejects.toThrow(/UNIQUE|constraint/i);

    // The index is partial, so any number of workouts may have none.
    await insert('cccccccc', null);
    await insert('dddddddd', null);

    // And another athlete may use the same key.
    const other = await seedUser('other@example.com');
    await env.DB.prepare(
      `INSERT INTO workouts (user_id, date, id, name, sport, steps, external_id, created_at, updated_at)
       VALUES (?, '2026-09-12', 'eeeeeeee', 'W', 'running', '[]', 'plan-1', '', '')`,
    )
      .bind(other.id)
      .run();
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

  it('holds the steps in the shape the caller wrote, queryable from SQL', async () => {
    const { id: userId } = await seedUser();
    await putWorkout(
      env,
      userId,
      parseWorkout({
        date: '2026-09-12',
        steps: [{ goal_s: 600 }, { repeat: 8, steps: [{ goal_meters: 400 }] }, { goal_s: 600 }],
      }),
    );

    const row = await env.DB.prepare(
      "SELECT json_array_length(steps) AS top_level, json_extract(steps, '$[1].repeat') AS reps, json_extract(steps, '$[0].goal_s') AS warmup FROM workouts WHERE user_id = ?",
    )
      .bind(userId)
      .first<{ top_level: number; reps: number; warmup: number }>();

    // The caller's own field names, not an internal encoding of them.
    expect(row).toEqual({ top_level: 3, reps: 8, warmup: 600 });
  });
});
