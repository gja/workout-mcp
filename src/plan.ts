/**
 * Writing to the athlete's plan.
 *
 * Every create, replace, delete and completion goes through here, whether it
 * arrived over REST or as an MCP tool call. Before this module the two had
 * their own copies of the same three-step dance — read the old row, carry the
 * completion across, delete before a move — and a change to the rules meant
 * finding both. Now the rules are here once, and each caller only shapes the
 * answer: a 404 on one side, a `ToolError` on the other.
 *
 * It is also the single place the connected platforms are told about a change,
 * which is what keeps intervals.icu in step no matter which door the write
 * came in through. A platform failing is never allowed to fail the write;
 * `platforms` records it against the connection instead.
 */

import * as db from './db';
import type { Env, User } from './db';
import * as platforms from './platforms';
import type { Workout, WorkoutInput } from './workout';

export async function createWorkout(env: Env, user: User, input: WorkoutInput): Promise<Workout> {
  // A create carrying an `external_id` that is already known is really an
  // update, and lands on that row even if it is on another date — so where
  // that row was has to be read before the write, or the platform link is
  // left pointing at a workout that no longer exists there.
  const previous = input.external_id ? await db.findByExternalId(env, user.id, input.external_id) : null;

  const workout = await db.putWorkout(env, user.id, input);
  await platforms.onWorkoutSaved(env, user, workout, previous ?? undefined);
  return workout;
}

/**
 * Replace a stored workout in full, keeping its id and moving it if the date
 * changed. Null when there is no such workout to replace.
 */
export async function replaceWorkout(
  env: Env,
  user: User,
  currentDate: string,
  id: string,
  input: WorkoutInput,
): Promise<Workout | null> {
  const existing = await db.getWorkout(env, user.id, currentDate, id);
  if (!existing) return null;

  // Replacing the plan is not un-doing the session, and a move deletes the
  // row the completion would otherwise have been carried across from.
  if (existing.completed_at) input.completed_at = existing.completed_at;
  // Before the delete below, so a refused date does not also cost the workout
  // the caller was trying to move.
  db.assertRetainable(input.date);
  if (input.date !== currentDate) await db.deleteWorkout(env, user.id, currentDate, id);

  const workout = await db.putWorkout(env, user.id, input, id);
  await platforms.onWorkoutSaved(env, user, workout, { date: currentDate, id });
  return workout;
}

export async function deleteWorkout(env: Env, user: User, date: string, id: string): Promise<boolean> {
  // The platforms are told after the row is gone but are looked up by the key
  // the row had, which the link table still holds — so a platform that is
  // down leaves a link to retry from rather than an untracked calendar entry.
  const deleted = await db.deleteWorkout(env, user.id, date, id);
  if (deleted) await platforms.onWorkoutDeleted(env, user, date, id);
  return deleted;
}

/**
 * Record that a workout was done, or clear that record.
 *
 * Deliberately not pushed to the connected platforms. A platform's own idea of
 * a completed session is a recorded activity, and manufacturing one from a tick
 * box would put a session in the athlete's training log that they never did.
 * The traffic goes the other way: `platforms.syncNow` reads completions back.
 */
export const setCompleted = (
  env: Env,
  user: User,
  date: string,
  id: string,
  completedAt: string | null,
): Promise<Workout | null> => db.setCompleted(env, user.id, date, id, completedAt);
