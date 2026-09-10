/**
 * D1 storage.
 *
 * One row per workout, keyed by (user, date, id). The normalized workout lives
 * in a JSON column: it is only ever read whole, and keeping it as JSON means
 * adding a step field never needs a migration.
 *
 * Retention is deliberately aggressive — a rolling window around today plus a
 * hard per-user cap — so the free tier is never the binding constraint.
 */

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { shiftDate, today } from './units';
import type { Workout, WorkoutInput } from './workout';

export const RETENTION_DAYS_PAST = 7;
export const RETENTION_DAYS_FUTURE = 14;
export const MAX_WORKOUTS_PER_USER = 50;

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
};

export type User = { id: string; email: string | null };

type WorkoutRow = { id: string; date: string; data: string };

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

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

const parseRow = (row: WorkoutRow): Workout => JSON.parse(row.data) as Workout;

export async function listWorkouts(env: Env, userId: string, from?: string, to?: string): Promise<Workout[]> {
  const window = retentionWindow();
  const { results } = await env.DB.prepare(
    'SELECT id, date, data FROM workouts WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date, created_at',
  )
    .bind(userId, from ?? window.from, to ?? window.to)
    .all<WorkoutRow>();
  return (results ?? []).map(parseRow);
}

export async function getWorkout(env: Env, userId: string, date: string, id: string): Promise<Workout | null> {
  const row = await env.DB.prepare('SELECT id, date, data FROM workouts WHERE user_id = ? AND date = ? AND id = ?')
    .bind(userId, date, id)
    .first<WorkoutRow>();
  return row ? parseRow(row) : null;
}

export async function putWorkout(env: Env, userId: string, input: WorkoutInput, id = newId()): Promise<Workout> {
  const workout: Workout = { version: 1, id, ...input, updated_at: new Date().toISOString() };
  await env.DB.prepare(
    `INSERT INTO workouts (user_id, date, id, name, sport, data, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT (user_id, date, id) DO UPDATE SET
       name = excluded.name, sport = excluded.sport, data = excluded.data, updated_at = excluded.updated_at`,
  )
    .bind(userId, workout.date, workout.id, workout.name, workout.sport, JSON.stringify(workout), workout.updated_at)
    .run();
  await prune(env, userId);
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
       SELECT rowid FROM workouts WHERE user_id = ?1 ORDER BY date DESC, created_at DESC LIMIT ?2
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
