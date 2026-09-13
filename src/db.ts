// D1 storage, the retention window and the per-athlete cap. See docs/database.md.

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { sessionOnly } from './stats';
import type { StatsSummary, WorkoutStats } from './stats';
import { fail, shiftDate, today } from './units';
import type { PlanStep, Sport, SubSport, Workout, WorkoutInput } from './workout';

export const RETENTION_DAYS_PAST = 7;
export const RETENTION_DAYS_FUTURE = 14;
export const MAX_WORKOUTS_PER_USER = 50;

/** Reads only: dates are the athlete's local day, the window is UTC, so the edges disagree. */
export const READ_SLACK_DAYS = 1;

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Where the OAuth provider keeps clients, grants and their tokens. */
  OAUTH_KV: KVNamespace;
  /** Injected by the OAuth provider on every request it passes through. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Shown on the dashboard and the consent page. */
  APP_NAME?: string;

  /** Google sign-in. Both are needed for the button to appear. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  /** Sign in with Apple. All four are needed for the button to appear. */
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  /** The .p8 private key, base64 PKCS#8, with or without its PEM armour. */
  APPLE_PRIVATE_KEY?: string;

  /** Any passphrase. Without it, connecting a training platform is refused outright. */
  CREDENTIALS_SECRET?: string;

  /** The intervals.icu OAuth app. Both are needed for sign-in, and for connecting without a key. */
  INTERVALS_CLIENT_ID?: string;
  INTERVALS_CLIENT_SECRET?: string;
  /** The secret intervals.icu puts in the body of every webhook it sends. Without it, none are accepted. */
  INTERVALS_WEBHOOK_SECRET?: string;
  /** The `Authorization` header configured on their end, when one is. Checked as well as the secret. */
  INTERVALS_WEBHOOK_AUTHORIZATION?: string;

  /** The Google service account the scheduled copier uploads as. Both are needed, or it does nothing. */
  GOOGLE_DRIVE_CLIENT_EMAIL?: string;
  /** Its private key, PEM PKCS#8, straight out of the JSON Google downloads. */
  GOOGLE_DRIVE_PRIVATE_KEY?: string;
};

export type User = { id: string; email: string | null };

type WorkoutRow = {
  id: string;
  date: string;
  name: string;
  sport: string;
  sub_sport: string | null;
  notes: string | null;
  /** A JSON array of strings, or null for none. */
  tags: string | null;
  external_id: string | null;
  steps: string;
  completed_at: string | null;
  /** The recorded session's stats, as `src/stats.ts` wrote them, or null until one comes back. */
  stats: string | null;
  updated_at: string;
};

/**
 * The columns every read needs, in one place.
 *
 * The laps are dropped in SQL rather than after parsing: they are the bulk of the
 * stats and nothing that reads a workout wants them. `getStats` is what asks.
 */
const WORKOUT_COLUMNS =
  'id, date, name, sport, sub_sport, notes, tags, external_id, steps, completed_at, ' +
  "json_remove(stats, '$.laps') AS stats, updated_at";

/** Short, URL-safe, unambiguous — no vowels, so no accidental words. */
const ID_ALPHABET = '0123456789bcdfghjkmnpqrstvwxyz';

export function newId(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

/** The window of dates we keep, inclusive. */
export function retentionWindow(now: Date = new Date()): { from: string; to: string } {
  const day = today(now);
  return { from: shiftDate(day, -RETENTION_DAYS_PAST), to: shiftDate(day, RETENTION_DAYS_FUTURE) };
}

// Every read goes through this. Nothing deletes, so this is the whole of the window.
export function readWindow(now: Date = new Date()): { from: string; to: string } {
  const day = today(now);
  return {
    from: shiftDate(day, -(RETENTION_DAYS_PAST + READ_SLACK_DAYS)),
    to: shiftDate(day, RETENTION_DAYS_FUTURE + READ_SLACK_DAYS),
  };
}

// --- Workouts --------------------------------------------------------------

function parseRow(row: WorkoutRow): Workout {
  const workout: Workout = {
    id: row.id,
    date: row.date,
    name: row.name,
    sport: row.sport as Sport,
    steps: JSON.parse(row.steps) as PlanStep[],
    updated_at: row.updated_at,
  };
  if (row.sub_sport) workout.sub_sport = row.sub_sport as SubSport;
  if (row.notes) workout.notes = row.notes;
  if (row.tags) {
    const tags = JSON.parse(row.tags) as string[];
    if (tags.length > 0) workout.tags = tags;
  }
  if (row.external_id) workout.external_id = row.external_id;
  if (row.completed_at) workout.completed_at = row.completed_at;
  if (row.stats) workout.stats = JSON.parse(row.stats) as StatsSummary;
  return workout;
}

/** A caller's range, narrowed to what a read is allowed to see. */
function readRange(from?: string, to?: string): { from: string; to: string } {
  const window = readWindow();
  return {
    from: from && from > window.from ? from : window.from,
    to: to && to < window.to ? to : window.to,
  };
}

export async function listWorkouts(env: Env, userId: string, from?: string, to?: string): Promise<Workout[]> {
  const range = readRange(from, to);
  const { results } = await env.DB.prepare(
    `SELECT ${WORKOUT_COLUMNS} FROM workouts
     WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date, created_at`,
  )
    .bind(userId, range.from, range.to)
    .all<WorkoutRow>();
  return (results ?? []).map(parseRow);
}

export async function getWorkout(env: Env, userId: string, date: string, id: string): Promise<Workout | null> {
  const window = readWindow();
  if (date < window.from || date > window.to) return null;

  const row = await env.DB.prepare(
    `SELECT ${WORKOUT_COLUMNS} FROM workouts WHERE user_id = ? AND date = ? AND id = ?`,
  )
    .bind(userId, date, id)
    .first<WorkoutRow>();
  return row ? parseRow(row) : null;
}

// Not narrowed to the read window: the key's unique index is not either.
export async function findByExternalId(
  env: Env,
  userId: string,
  externalId: string,
): Promise<{ date: string; id: string } | null> {
  const row = await env.DB.prepare('SELECT date, id FROM workouts WHERE user_id = ? AND external_id = ?')
    .bind(userId, externalId)
    .first<{ date: string; id: string }>();
  return row ?? null;
}

/** Ask before deleting the old row on a move, or a refusal costs the workout too. */
export function assertRetainable(date: string): void {
  const window = retentionWindow();
  if (date < window.from || date > window.to) {
    fail('date', `only ${window.from} to ${window.to} is kept, so a workout on ${date} could not be read back`);
  }
}

// Counted inside the window, not over the table, so the cap rolls rather than fills up.
async function assertRoomFor(env: Env, userId: string, date: string): Promise<void> {
  if ((await countInWindow(env, userId)) < MAX_WORKOUTS_PER_USER) return;
  fail(
    'date',
    `only ${MAX_WORKOUTS_PER_USER} workouts are kept at a time, so ${date} would not fit; delete one first`,
  );
}

// Not window-narrowed: asked about a row that is about to be written over, not read back.
async function storedRecord(
  env: Env,
  userId: string,
  date: string,
  id: string,
): Promise<{ completed_at: string | null; stats: string | null; steps: string | null }> {
  const row = await env.DB.prepare(
    'SELECT completed_at, stats, steps FROM workouts WHERE user_id = ? AND date = ? AND id = ?',
  )
    .bind(userId, date, id)
    .first<{ completed_at: string | null; stats: string | null; steps: string | null }>();
  return row ?? { completed_at: null, stats: null, steps: null };
}

/** `previous` is where the row being replaced is now, when the caller has already moved it. */
export async function putWorkout(
  env: Env,
  userId: string,
  input: WorkoutInput,
  id?: string,
  previous?: { date: string; id: string },
): Promise<Workout> {
  let workoutId = id;

  assertRetainable(input.date);

  /**
   * Rewriting a workout does not un-do the session: the completion comes across, and so
   * do the stats read off it.
   *
   * What may not come across is a changed *plan* under them. A lap mapped to "Threshold,
   * rep 2" of a plan that has since been rewritten is a confident answer about a step
   * that no longer exists, so once a session has been recorded the steps are history and
   * are refused. Everything else about the workout — its name, its notes, its tags, the
   * day it sits on — still moves. Un-complete it first to change the plan itself, which
   * is the honest order: the session was not this workout after all.
   *
   * The steps are compared even so, for the workout that was un-completed while its
   * stats stayed: there the mapping is dropped and the next pass reads the recording
   * again, against the plan as it now stands.
   */
  let completedAt = input.completed_at ?? null;
  let stats: string | null = null;
  const carryFrom = async (date: string, rowId: string) => {
    const stored = await storedRecord(env, userId, date, rowId);
    const samePlan = stored.steps === JSON.stringify(input.steps);

    if (stored.completed_at && !samePlan) {
      fail(
        'steps',
        `this workout was recorded as done on ${stored.completed_at.slice(0, 10)}, so its steps ` +
          'cannot be rewritten; mark it not done first if the session was not this one',
      );
    }
    if (input.completed_at === undefined) completedAt = stored.completed_at;
    stats = samePlan ? stored.stats : null;
  };

  // Where what is being replaced lives now, which is not where it is going on a move.
  const replacing = previous ?? (workoutId === undefined ? null : { date: input.date, id: workoutId });

  // Read, then cleared, in that order: the delete would take both across with it.
  const carryAcross = async (from: { date: string; id: string }) => {
    await carryFrom(from.date, from.id);
    if (from.date !== input.date) await deleteWorkout(env, userId, from.date, from.id);
  };

  // A caller with its own key is re-syncing: land on the row that key already names.
  if (input.external_id) {
    const existing = await findByExternalId(env, userId, input.external_id);
    if (existing && workoutId === undefined) {
      workoutId = existing.id;
    } else if (existing && existing.id !== workoutId) {
      // Caught here, or the unique index breaks and the caller's mistake reads as a 500.
      fail('external_id', `"${input.external_id}" already belongs to workout ${existing.id} on ${existing.date}`);
    }
    if (existing) await carryAcross(existing);
    else if (replacing) await carryAcross(replacing);
  } else if (replacing) {
    await carryAcross(replacing);
  }

  // The only write that adds a row: every path reusing an id has checked it exists.
  if (workoutId === undefined) await assertRoomFor(env, userId, input.date);

  const workout: Workout = { id: workoutId ?? newId(), ...input, updated_at: new Date().toISOString() };
  if (completedAt) workout.completed_at = completedAt;
  else delete workout.completed_at;
  if (stats) workout.stats = sessionOnly(JSON.parse(stats) as WorkoutStats);
  else delete workout.stats;
  await env.DB.prepare(
    `INSERT INTO workouts (user_id, date, id, name, sport, sub_sport, notes, tags, external_id, steps, completed_at, stats, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
     ON CONFLICT (user_id, date, id) DO UPDATE SET
       name = excluded.name, sport = excluded.sport, sub_sport = excluded.sub_sport,
       notes = excluded.notes, tags = excluded.tags, external_id = excluded.external_id,
       steps = excluded.steps, completed_at = excluded.completed_at, stats = excluded.stats,
       updated_at = excluded.updated_at`,
  )
    .bind(
      userId,
      workout.date,
      workout.id,
      workout.name,
      workout.sport,
      workout.sub_sport ?? null,
      workout.notes ?? null,
      workout.tags && workout.tags.length > 0 ? JSON.stringify(workout.tags) : null,
      workout.external_id ?? null,
      JSON.stringify(workout.steps),
      workout.completed_at ?? null,
      stats,
      workout.updated_at,
    )
    .run();
  return workout;
}

/** Its own write, not a field on the plan. Null when there is no such workout. */
export async function setCompleted(
  env: Env,
  userId: string,
  date: string,
  id: string,
  completedAt: string | null,
): Promise<Workout | null> {
  const window = readWindow();
  if (date < window.from || date > window.to) return null;

  const result = await env.DB.prepare(
    'UPDATE workouts SET completed_at = ?, updated_at = ? WHERE user_id = ? AND date = ? AND id = ?',
  )
    .bind(completedAt, new Date().toISOString(), userId, date, id)
    .run();
  if ((result.meta.changes ?? 0) === 0) return null;
  return getWorkout(env, userId, date, id);
}

/** The whole document, laps and all. Read on its own, for the reason `WORKOUT_COLUMNS` gives. */
export async function getStats(env: Env, userId: string, date: string, id: string): Promise<WorkoutStats | null> {
  const window = readWindow();
  if (date < window.from || date > window.to) return null;

  const row = await env.DB.prepare('SELECT stats FROM workouts WHERE user_id = ? AND date = ? AND id = ?')
    .bind(userId, date, id)
    .first<{ stats: string | null }>();
  return row?.stats ? (JSON.parse(row.stats) as WorkoutStats) : null;
}

/** Written by the platform sync alone, once the recording behind a completion has been read. */
export async function setStats(
  env: Env,
  userId: string,
  date: string,
  id: string,
  stats: WorkoutStats,
): Promise<void> {
  await env.DB.prepare('UPDATE workouts SET stats = ? WHERE user_id = ? AND date = ? AND id = ?')
    .bind(JSON.stringify(stats), userId, date, id)
    .run();
}

export async function deleteWorkout(env: Env, userId: string, date: string, id: string): Promise<boolean> {
  const result = await env.DB.prepare('DELETE FROM workouts WHERE user_id = ? AND date = ? AND id = ?')
    .bind(userId, date, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** How many workouts an athlete has inside the window, for the cap. */
export async function countInWindow(env: Env, userId: string, now: Date = new Date()): Promise<number> {
  const { from, to } = retentionWindow(now);
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM workouts WHERE user_id = ? AND date >= ? AND date <= ?',
  )
    .bind(userId, from, to)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
