// The one door for every write to the plan, and the platforms it tells. See docs/architecture.md.

import * as db from './db';
import type { Env, User } from './db';
import * as platforms from './platforms';
import { statsFrom } from './stats';
import type { Source, WorkoutStats } from './stats';
import type { Workout, WorkoutInput } from './workout';

export async function createWorkout(env: Env, user: User, input: WorkoutInput): Promise<Workout> {
  // A known `external_id` makes this an update, possibly on another date — so
  // where the row was has to be read before the write, or its link is orphaned.
  const previous = input.external_id ? await db.findByExternalId(env, user.id, input.external_id) : null;

  const workout = await db.putWorkout(env, user.id, input);
  await platforms.onWorkoutSaved(env, user, workout, previous ?? undefined);
  return workout;
}

/** Replace in full, keeping the id and moving it if the date changed. Null if there is none. */
export async function replaceWorkout(
  env: Env,
  user: User,
  currentDate: string,
  id: string,
  input: WorkoutInput,
): Promise<Workout | null> {
  const existing = await db.getWorkout(env, user.id, currentDate, id);
  if (!existing) return null;

  if (existing.completed_at) input.completed_at = existing.completed_at;

  // Where it is now, which on a move is not where it is going: `putWorkout` reads the
  // completion and the stats off that row, and clears it, in that order.
  const workout = await db.putWorkout(env, user.id, input, id, { date: currentDate, id });
  await platforms.onWorkoutSaved(env, user, workout, { date: currentDate, id });
  return workout;
}

export async function deleteWorkout(env: Env, user: User, date: string, id: string): Promise<boolean> {
  // Told after the row is gone; the link table still holds the key, so a failure retries.
  const deleted = await db.deleteWorkout(env, user.id, date, id);
  if (deleted) await platforms.onWorkoutDeleted(env, user, date, id);
  return deleted;
}

/** Deliberately not pushed: completions travel the other way, off the platform. */
export const setCompleted = (
  env: Env,
  user: User,
  date: string,
  id: string,
  completedAt: string | null,
): Promise<Workout | null> => db.setCompleted(env, user.id, date, id, completedAt);

/**
 * The athlete's note on how the session went — and, unlike a completion, this one
 * does travel out: it is theirs to write, and the recorded session upstream is where
 * they will read it back. Null clears it, there as well as here.
 */
export async function setComment(
  env: Env,
  user: User,
  date: string,
  id: string,
  comment: string | null,
): Promise<Workout | null> {
  const workout = await db.setComment(env, user.id, date, id, comment);
  if (workout) await platforms.onCommentSaved(env, user, workout);
  return workout;
}

/**
 * A recording handed straight to us rather than fetched off a platform.
 *
 * Read once into the same numbers the platform sync stores, and the bytes dropped:
 * nothing here ever holds the file, the record stream or the track. The session is
 * marked done at the moment the recording ended, unless it already was — an upload
 * is evidence that it happened, not a correction of when. See docs/stats.md.
 */
export async function recordSession(
  env: Env,
  user: User,
  date: string,
  id: string,
  bytes: Uint8Array,
  source: Source,
): Promise<{ workout: Workout; stats: WorkoutStats } | null> {
  const existing = await db.getWorkout(env, user.id, date, id);
  if (!existing) return null;

  const stats = statsFrom(bytes, existing, source);
  await db.setStats(env, user.id, date, id, stats);

  const workout = await setCompleted(env, user, date, id, existing.completed_at ?? endedAt(stats));
  return workout ? { workout, stats } : null;
}

/** When the recording ended, which is when the session was done. Now, where the file did not say. */
function endedAt(stats: WorkoutStats): string {
  const start = Date.parse(stats.session?.start_time ?? '');
  if (Number.isNaN(start)) return new Date().toISOString();
  return new Date(start + (stats.session?.elapsed_s ?? 0) * 1000).toISOString();
}
