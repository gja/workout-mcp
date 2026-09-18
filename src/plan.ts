// The one door for every write to the plan, and the platforms it tells. See docs/architecture.md.

import * as db from './db';
import type { Env, User } from './db';
import * as platforms from './platforms';
import { statsFrom } from './stats';
import type { Source, WorkoutStats } from './stats';
import type { Workout, WorkoutInput } from './workout';

export async function createWorkout(env: Env, user: User, input: WorkoutInput): Promise<Workout> {
  // A known `external_id` makes this an update, possibly on another date — and the
  // platform link is keyed by the date it was on, so where the row was has to be read
  // before the write, or that link is orphaned.
  const previous = input.external_id ? await db.findByExternalId(env, user.id, input.external_id) : null;

  const workout = await db.putWorkout(env, user.id, input);
  await platforms.onWorkoutSaved(env, user, workout, previous ?? undefined);
  return workout;
}

/** The id says which workout; where it currently sits is the row's business, not the caller's. */
export async function replaceWorkout(env: Env, user: User, id: string, input: WorkoutInput): Promise<Workout | null> {
  const existing = await db.getWorkout(env, user.id, id);
  if (!existing) return null;

  if (existing.completed_at) input.completed_at = existing.completed_at;

  const workout = await db.putWorkout(env, user.id, input, id);
  await platforms.onWorkoutSaved(env, user, workout, { date: existing.date, id });
  return workout;
}

/**
 * Its own verb because a caller that only wants the session a day later should not have to
 * resend the plan — and resending it is what a recorded session refuses. Nothing but the
 * date changes, so the completion, the note and the stats need no carrying.
 */
export async function moveWorkout(env: Env, user: User, id: string, date: string): Promise<Workout | null> {
  const existing = await db.getWorkout(env, user.id, id);
  if (!existing) return null;
  if (date === existing.date) return existing;

  const workout = await db.setDate(env, user.id, id, date);
  if (workout) await platforms.onWorkoutSaved(env, user, workout, { date: existing.date, id });
  return workout;
}

export async function deleteWorkout(env: Env, user: User, id: string): Promise<Workout | null> {
  // Read first for the day it was on: the platform link is keyed by that, and the delete
  // leaves nobody to ask. Told afterwards, so a failure there retries off the link.
  const existing = await db.getWorkout(env, user.id, id);
  if (!existing) return null;

  if (!(await db.deleteWorkout(env, user.id, id))) return null;
  await platforms.onWorkoutDeleted(env, user, existing.date, id);
  return existing;
}

/** Deliberately not pushed: completions travel the other way, off the platform. */
export const setCompleted = (
  env: Env,
  user: User,
  id: string,
  completedAt: string | null,
): Promise<Workout | null> => db.setCompleted(env, user.id, id, completedAt);

/**
 * The athlete's note on how the session went — and, unlike a completion, this one
 * does travel out: it is theirs to write, and the recorded session upstream is where
 * they will read it back. Null clears it, there as well as here.
 */
export async function setComment(
  env: Env,
  user: User,
  id: string,
  comment: string | null,
): Promise<Workout | null> {
  const workout = await db.setComment(env, user.id, id, comment);
  if (workout) await platforms.onCommentSaved(env, user, workout);
  return workout;
}

/**
 * Read once into the same numbers the platform sync stores, and the bytes dropped. Marked
 * done at the moment the recording ended, unless it already was: an upload is evidence
 * that it happened, not a correction of when. See docs/stats.md.
 */
export async function recordSession(
  env: Env,
  user: User,
  id: string,
  bytes: Uint8Array,
  source: Source,
): Promise<{ workout: Workout; stats: WorkoutStats } | null> {
  const existing = await db.getWorkout(env, user.id, id);
  if (!existing) return null;

  const stats = statsFrom(bytes, existing, source);
  await db.setStats(env, user.id, id, stats);

  const workout = await setCompleted(env, user, id, existing.completed_at ?? endedAt(stats));
  return workout ? { workout, stats } : null;
}

/** When the recording ended, which is when the session was done. Now, where the file did not say. */
function endedAt(stats: WorkoutStats): string {
  const start = Date.parse(stats.session?.start_time ?? '');
  if (Number.isNaN(start)) return new Date().toISOString();
  return new Date(start + (stats.session?.elapsed_s ?? 0) * 1000).toISOString();
}
