// The one door for every write to the plan, and the platforms it tells. See docs/architecture.md.

import * as db from './db';
import type { Env, User } from './db';
import * as platforms from './platforms';
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

  // Read before the delete below, which would take the completion with it.
  if (existing.completed_at) input.completed_at = existing.completed_at;
  // Also before it, so a refused date does not cost the workout being moved.
  db.assertRetainable(input.date);
  if (input.date !== currentDate) await db.deleteWorkout(env, user.id, currentDate, id);

  const workout = await db.putWorkout(env, user.id, input, id);
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
