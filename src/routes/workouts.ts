/**
 * The workouts themselves: the REST API the dashboard talks to, the MCP tool
 * surface reachable over plain REST, and the FIT download a watch follows.
 */

import * as db from '../db';
import { encodeWorkoutFit, fitFilename } from '../fit';
import type { AuthedRoute, Context } from '../http';
import { error, json, withUser } from '../http';
import type { Router } from '../router';
import { syncWorkouts } from '../sync';
import { callTool, present, presentBrief } from '../tools';
import { parseDate, parseTimestamp } from '../units';
import { parseWorkout } from '../workout';

/** The `:date`/`:id` pair every single-workout route is addressed by. */
type WorkoutRoute = '/api/workouts/:date(\\d{4}-\\d{2}-\\d{2})/:id([0-9a-z]+)';
type CompletionRoute = `${WorkoutRoute}/complete`;

const WORKOUT: WorkoutRoute = '/api/workouts/:date(\\d{4}-\\d{2}-\\d{2})/:id([0-9a-z]+)';

const listWorkouts: AuthedRoute = async ({ url, env, user }) => {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const workouts = await db.listWorkouts(
    env,
    user.id,
    from ? parseDate(from, 'from') : undefined,
    to ? parseDate(to, 'to') : undefined,
  );
  return json({ workouts: workouts.map((workout) => present(workout, url.origin)) });
};

const createWorkout: AuthedRoute = async ({ request, url, env, user, background }) => {
  const workout = await db.putWorkout(env, user.id, parseWorkout(await request.json()));
  // Creating a workout should put it on the athlete's calendar without anyone
  // remembering to sync. Scheduled rather than awaited, so a platform being
  // down cannot fail a write that is already saved.
  syncWorkouts(env, user.id, background);
  return json(presentBrief(workout, url.origin), 201);
};

const getWorkout: AuthedRoute<WorkoutRoute> = async ({ url, env, user, params }) => {
  const date = parseDate(params.date, 'date');
  const workout = await db.getWorkout(env, user.id, date, params.id);
  return workout ? json(present(workout, url.origin)) : error(`no workout ${params.id} on ${date}`, 404);
};

const replaceWorkout: AuthedRoute<WorkoutRoute> = async ({ request, url, env, user, params, background }) => {
  const date = parseDate(params.date, 'date');
  const existing = await db.getWorkout(env, user.id, date, params.id);
  if (!existing) return error(`no workout ${params.id} on ${date}`, 404);

  const input = parseWorkout(await request.json());
  // Replacing the plan is not un-doing the session, and a move deletes the
  // row the completion would otherwise have been carried across from.
  if (existing.completed_at) input.completed_at = existing.completed_at;
  // Before the delete below, so a refused date does not also cost the
  // workout the caller was trying to move.
  db.assertRetainable(input.date);
  if (input.date !== date) await db.deleteWorkout(env, user.id, date, params.id);
  const workout = await db.putWorkout(env, user.id, input, params.id);
  syncWorkouts(env, user.id, background);
  return json(presentBrief(workout, url.origin));
};

const deleteWorkout: AuthedRoute<WorkoutRoute> = async ({ env, user, params, background }) => {
  const date = parseDate(params.date, 'date');
  const deleted = await db.deleteWorkout(env, user.id, date, params.id);
  if (!deleted) return error(`no workout ${params.id} on ${date}`, 404);
  // A deleted workout has to come off the calendar too, which is the same
  // diff seen from the other side.
  syncWorkouts(env, user.id, background);
  return json({ deleted: true, date, id: params.id });
};

/**
 * Completing a workout is its own verb rather than a field on the plan, so
 * marking a session done does not mean resending — or risk rewriting — it.
 */
const setCompletion = async (
  context: Parameters<AuthedRoute<CompletionRoute>>[0],
  completedAt: string | null,
): Promise<Response> => {
  const { url, env, user, params } = context;
  const date = parseDate(params.date, 'date');
  const workout = await db.setCompleted(env, user.id, date, params.id, completedAt);
  return workout ? json(presentBrief(workout, url.origin)) : error(`no workout ${params.id} on ${date}`, 404);
};

const completeWorkout: AuthedRoute<CompletionRoute> = async (context) => {
  // An empty body means now, which is the common case from the dashboard.
  const body = (await context.request.json().catch(() => ({}))) as { completed_at?: unknown };
  const completedAt =
    body?.completed_at === undefined || body.completed_at === null
      ? new Date().toISOString()
      : parseTimestamp(body.completed_at, 'completed_at');
  return await setCompletion(context, completedAt);
};

const uncompleteWorkout: AuthedRoute<CompletionRoute> = (context) => setCompletion(context, null);

/** The MCP tools, reachable over plain REST. */
const runTool: AuthedRoute<'/api/tools/:name([a-z_]+)'> = async ({
  request,
  url,
  env,
  user,
  params,
  background,
}) => json(await callTool(params.name, await request.json(), env, user, url.origin, background));

/** `2026-09-12-a1b2c3d4` -> its parts. */
function splitDateId(slug: string): { date: string; id: string } | null {
  if (slug.length < 12 || slug[10] !== '-') return null;
  const date = slug.slice(0, 10);
  const id = slug.slice(11);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[0-9a-z]+$/.test(id)) return null;
  return { date, id };
}

const exportFit: AuthedRoute<'/export/:slug'> = async ({ env, user, params }) => {
  const parts = splitDateId(params.slug.replace(/\.fit$/, ''));
  if (!parts) return error('expected /export/YYYY-MM-DD-<id>.fit', 400);

  const workout = await db.getWorkout(env, user.id, parts.date, parts.id);
  if (!workout) return error(`no workout ${parts.id} on ${parts.date}`, 404);

  return new Response(encodeWorkoutFit(workout), {
    headers: {
      'Content-Type': 'application/vnd.ant.fit',
      'Content-Disposition': `attachment; filename="${fitFilename(workout)}"`,
      'Cache-Control': 'no-store',
    },
  });
};

export const routes = (app: Router<Context>): void => {
  app
    .get('/api/workouts', withUser(listWorkouts))
    .post('/api/workouts', withUser(createWorkout))
    .get(WORKOUT, withUser(getWorkout))
    .put(WORKOUT, withUser(replaceWorkout))
    .delete(WORKOUT, withUser(deleteWorkout))
    .post(`${WORKOUT}/complete`, withUser(completeWorkout))
    .delete(`${WORKOUT}/complete`, withUser(uncompleteWorkout))

    .post('/api/tools/:name([a-z_]+)', withUser(runTool))

    .get('/export/:slug', withUser(exportFit));
};
