/**
 * D1 storage.
 *
 * One row per workout, keyed by (user, date, id). The scalar fields are real
 * columns; only the steps are JSON, because only they have a shape that
 * changes. SQLite has no JSON column type, so that is a TEXT column with a
 * `json_valid` check — and the JSON functions still work over it, should a
 * query ever need to reach inside.
 *
 * Retention is deliberately aggressive — a rolling window around today plus a
 * hard per-user cap — so the free tier is never the binding constraint.
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
   * Pushing workouts to Garmin Connect. Both are needed for the integration
   * to appear at all; they come from a Garmin Connect Developer Program app
   * with the Training API enabled.
   */
  GARMIN_CLIENT_ID?: string;
  GARMIN_CLIENT_SECRET?: string;
  /**
   * Optional. Encrypts the stored Garmin tokens; the client secret is used
   * when this is unset. Setting it means the client secret can be rotated
   * without every athlete having to reconnect.
   */
  GARMIN_ENCRYPTION_KEY?: string;
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
  updated_at: string;
};

/** The columns every read needs, in one place. */
const WORKOUT_COLUMNS = 'id, date, name, sport, sub_sport, notes, external_id, steps, updated_at';

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
 * whatever it asks for. A row that somehow outlived the sweep is not visible
 * either; it simply waits to be swept.
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
 * Refuse a date the retention sweep would drop again immediately, rather than
 * accepting the write and silently throwing it away.
 *
 * Callers that move a workout delete the old row before writing the new one,
 * so they have to ask this *before* deleting: failing in between would answer
 * with a 400 and still have lost the workout.
 */
export function assertRetainable(date: string): void {
  const window = retentionWindow();
  if (date < window.from || date > window.to) {
    fail('date', `only ${window.from} to ${window.to} is kept, so a workout on ${date} would be dropped straight away`);
  }
}

export async function putWorkout(env: Env, userId: string, input: WorkoutInput, id?: string): Promise<Workout> {
  let workoutId = id;

  assertRetainable(input.date);

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
    // The workout moved day; the old row has to go before the new one lands.
    if (existing && existing.date !== input.date) await deleteWorkout(env, userId, existing.date, existing.id);
  }

  const workout: Workout = { id: workoutId ?? newId(), ...input, updated_at: new Date().toISOString() };
  await env.DB.prepare(
    `INSERT INTO workouts (user_id, date, id, name, sport, sub_sport, notes, external_id, steps, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
     ON CONFLICT (user_id, date, id) DO UPDATE SET
       name = excluded.name, sport = excluded.sport, sub_sport = excluded.sub_sport,
       notes = excluded.notes, external_id = excluded.external_id,
       steps = excluded.steps, updated_at = excluded.updated_at`,
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
      workout.updated_at,
    )
    .run();
  await prune(env, userId);

  // The date is inside the window, but the per-user cap keeps the newest and
  // this write may have been the oldest. Saying so beats handing back an id
  // and a download URL for a workout that is already gone.
  if (!(await getWorkout(env, userId, workout.date, workout.id))) {
    fail('date', `only ${MAX_WORKOUTS_PER_USER} workouts are kept, newest dates first, and ${workout.date} lost out`);
  }
  return workout;
}

export async function deleteWorkout(env: Env, userId: string, date: string, id: string): Promise<boolean> {
  const result = await env.DB.prepare('DELETE FROM workouts WHERE user_id = ? AND date = ? AND id = ?')
    .bind(userId, date, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Drop anything outside the retention window, then anything past the per-user
 * cap (oldest first). Cheap enough to run on every write.
 */
export async function prune(env: Env, userId: string, now: Date = new Date()): Promise<number> {
  const { from, to } = retentionWindow(now);
  const expired = await env.DB.prepare('DELETE FROM workouts WHERE user_id = ? AND (date < ? OR date > ?)')
    .bind(userId, from, to)
    .run();
  const overflow = await env.DB.prepare(
    `DELETE FROM workouts WHERE user_id = ?1 AND rowid NOT IN (
       SELECT rowid FROM workouts WHERE user_id = ?1 ORDER BY date DESC, created_at DESC, rowid DESC LIMIT ?2
     )`,
  )
    .bind(userId, MAX_WORKOUTS_PER_USER)
    .run();
  return (expired.meta.changes ?? 0) + (overflow.meta.changes ?? 0);
}

/** Retention sweep across every user, for the scheduled trigger. */
export async function pruneAll(env: Env, now: Date = new Date()): Promise<number> {
  const { from, to } = retentionWindow(now);
  const result = await env.DB.prepare('DELETE FROM workouts WHERE date < ? OR date > ?').bind(from, to).run();
  return result.meta.changes ?? 0;
}
