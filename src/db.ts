/**
 * D1 storage.
 *
 * One row per workout, keyed by (user, date, id). The scalar fields are real
 * columns; only the steps are JSON, because only they have a shape that
 * changes. SQLite has no JSON column type, so that is a TEXT column with a
 * `json_valid` check — and the JSON functions still work over it, should a
 * query ever need to reach inside.
 *
 * Nothing here deletes a workout the athlete did not delete. The limits — a
 * rolling window around today, and a per-user cap — are enforced on the way
 * in: a write outside the window or past the cap is refused, and every read is
 * bounded to the window. A row that drifts out of the window as time moves
 * past simply stops being visible, and stays in the table.
 *
 * That is a deliberate reversal of what this used to do, which was sweep old
 * rows nightly. Storage is not the binding constraint on the free tier —
 * 5 GB against a few hundred bytes a workout — and deleting an athlete's
 * training history to save none of it was the wrong trade.
 */

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { fail, shiftDate, today } from './units';
import type { PlanStep, Sport, SubSport, Workout, WorkoutInput } from './workout';

export const RETENTION_DAYS_PAST = 7;
export const RETENTION_DAYS_FUTURE = 14;
export const MAX_WORKOUTS_PER_USER = 50;

/**
 * A day of slack on each side of the retention window, for reads only.
 *
 * Dates are the athlete's local day but the window is computed in UTC, so at
 * the edges the two can disagree by a day. Writes take the strict window —
 * there is no point storing what the sweep will drop — while reads take the
 * slack, so a workout stored yesterday in Auckland is still legible today.
 */
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

  /** Optional sign-up allowlist: addresses or "@domain", comma separated. */
  ALLOWED_EMAILS?: string;

  /**
   * Encrypts the API keys athletes paste in for intervals.icu and any other
   * training platform. Any passphrase will do; without it those connections
   * are refused rather than stored in the clear.
   */
  CREDENTIALS_SECRET?: string;
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

/**
 * The widest span of dates a read may reach, inclusive.
 *
 * Every read goes through this, so no caller — a `from`/`to` on the list, a
 * date in a URL, a FIT download — can reach a workout outside the window,
 * whatever it asks for. This is the whole of how the window is enforced now
 * that nothing deletes: an older workout is still in the table, and this is
 * what stops it being read back.
 */
export function readWindow(now: Date = new Date()): { from: string; to: string } {
  const day = today(now);
  return {
    from: shiftDate(day, -(RETENTION_DAYS_PAST + READ_SLACK_DAYS)),
    to: shiftDate(day, RETENTION_DAYS_FUTURE + READ_SLACK_DAYS),
  };
}

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

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

/**
 * Where an already-stored workout with this caller-supplied key lives.
 *
 * Deliberately not narrowed to the read window, unlike the reads above: the
 * key's unique index is not narrowed either, so a row the sweep has not caught
 * yet still has to be found — otherwise a re-sync would try to insert a second
 * row under the same key and break the index.
 */
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

/**
 * Refuse a date outside the window, rather than accepting a write that would
 * land somewhere nothing can read back.
 *
 * Callers that move a workout delete the old row before writing the new one,
 * so they have to ask this *before* deleting: failing in between would answer
 * with a 400 and still have lost the workout.
 */
export function assertRetainable(date: string): void {
  const window = retentionWindow();
  if (date < window.from || date > window.to) {
    fail('date', `only ${window.from} to ${window.to} is kept, so a workout on ${date} could not be read back`);
  }
}

/**
 * Refuse a new workout past the cap, rather than making room by deleting
 * somebody's older session.
 *
 * Counted inside the window rather than over the whole table, which is what
 * keeps the cap rolling: rows that drift out of the window stop counting, so
 * an athlete who has trained for a year is not permanently full.
 */
async function assertRoomFor(env: Env, userId: string, date: string): Promise<void> {
  if ((await countInWindow(env, userId)) < MAX_WORKOUTS_PER_USER) return;
  fail(
    'date',
    `only ${MAX_WORKOUTS_PER_USER} workouts are kept at a time, so ${date} would not fit; delete one first`,
  );
}

/**
 * The completion a stored row already carries, or null.
 *
 * Not narrowed to the read window, for the same reason `findByExternalId` is
 * not: it is asked about a row that is about to be overwritten, which is a
 * row that exists whatever the sweep has yet to catch up on.
 */
async function storedCompletion(env: Env, userId: string, date: string, id: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT completed_at FROM workouts WHERE user_id = ? AND date = ? AND id = ?')
    .bind(userId, date, id)
    .first<{ completed_at: string | null }>();
  return row?.completed_at ?? null;
}

export async function putWorkout(env: Env, userId: string, input: WorkoutInput, id?: string): Promise<Workout> {
  let workoutId = id;

  assertRetainable(input.date);

  /**
   * Rewriting the plan does not un-do the session. Unless the caller has said
   * what the completion should be, whatever the row it lands on already
   * carries comes across — which is what keeps a plan re-synced under its
   * `external_id` from quietly marking a finished session unfinished again.
   */
  let completedAt = input.completed_at ?? null;
  const carryFrom = async (date: string, rowId: string) => {
    if (input.completed_at === undefined) completedAt = await storedCompletion(env, userId, date, rowId);
  };

  // A caller that supplies its own key is re-syncing: land on the row that
  // key already names, rather than creating a second copy of the session.
  if (input.external_id) {
    const existing = await findByExternalId(env, userId, input.external_id);
    if (existing && workoutId === undefined) {
      workoutId = existing.id;
    } else if (existing && existing.id !== workoutId) {
      // The key is unique per athlete, so letting this reach the INSERT would
      // break the index and surface as a 500 rather than as the caller's
      // mistake that it is.
      fail('external_id', `"${input.external_id}" already belongs to workout ${existing.id} on ${existing.date}`);
    }
    // Read before the delete below, which would take the completion with it.
    if (existing) await carryFrom(existing.date, existing.id);
    // The workout moved day; the old row has to go before the new one lands.
    if (existing && existing.date !== input.date) await deleteWorkout(env, userId, existing.date, existing.id);
  } else if (workoutId !== undefined) {
    await carryFrom(input.date, workoutId);
  }

  // A row no caller named is a new one. Every path that reuses an id has
  // checked the row exists first, so this is the only write that adds to the
  // count — and the only one the cap has anything to say about.
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

/**
 * Record that a workout was done, or clear that record.
 *
 * Its own write rather than a field on the plan: marking a session done is
 * what an athlete does after the fact, and it should not need to resend — or
 * risk rewriting — the steps. Bounded by the read window like every other
 * lookup, so a row the sweep has yet to drop cannot be reached through it.
 * Returns the workout as it now stands, or null if there is none to complete.
 */
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
