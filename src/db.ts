// D1 storage, the retention window and the per-athlete cap. See docs/database.md.

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
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
  external_id: string | null;
  steps: string;
  completed_at: string | null;
  updated_at: string;
};

/** The columns every read needs, in one place. */
const WORKOUT_COLUMNS =
  'id, date, name, sport, sub_sport, notes, external_id, steps, completed_at, updated_at';

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
  if (row.external_id) workout.external_id = row.external_id;
  if (row.completed_at) workout.completed_at = row.completed_at;
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
async function storedCompletion(env: Env, userId: string, date: string, id: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT completed_at FROM workouts WHERE user_id = ? AND date = ? AND id = ?')
    .bind(userId, date, id)
    .first<{ completed_at: string | null }>();
  return row?.completed_at ?? null;
}

export async function putWorkout(env: Env, userId: string, input: WorkoutInput, id?: string): Promise<Workout> {
  let workoutId = id;

  assertRetainable(input.date);

  // Rewriting the plan does not un-do the session: the stored completion comes across.
  let completedAt = input.completed_at ?? null;
  const carryFrom = async (date: string, rowId: string) => {
    if (input.completed_at === undefined) completedAt = await storedCompletion(env, userId, date, rowId);
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
    // Read before the delete below, which would take the completion with it.
    if (existing) await carryFrom(existing.date, existing.id);
    // The workout moved day; the old row has to go before the new one lands.
    if (existing && existing.date !== input.date) await deleteWorkout(env, userId, existing.date, existing.id);
  } else if (workoutId !== undefined) {
    await carryFrom(input.date, workoutId);
  }

  // The only write that adds a row: every path reusing an id has checked it exists.
  if (workoutId === undefined) await assertRoomFor(env, userId, input.date);

  const workout: Workout = { id: workoutId ?? newId(), ...input, updated_at: new Date().toISOString() };
  if (completedAt) workout.completed_at = completedAt;
  else delete workout.completed_at;
  await env.DB.prepare(
    `INSERT INTO workouts (user_id, date, id, name, sport, sub_sport, notes, external_id, steps, completed_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
     ON CONFLICT (user_id, date, id) DO UPDATE SET
       name = excluded.name, sport = excluded.sport, sub_sport = excluded.sub_sport,
       notes = excluded.notes, external_id = excluded.external_id,
       steps = excluded.steps, completed_at = excluded.completed_at,
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
      workout.external_id ?? null,
      JSON.stringify(workout.steps),
      workout.completed_at ?? null,
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
