// The REST API, the tools over plain REST, and the FIT download a watch follows.

import * as db from '../db';
import { encodeWorkoutFit, fitFilename } from '../fit';
import type { AuthedRoute, Context } from '../http';
import { CORS_HEADERS, error, json, withUser } from '../http';
import * as plan from '../plan';
import { resolveSteps } from '../resolve';
import type { Router } from '../router';
import { MAX_RECORDING_BYTES, StatsError } from '../stats';
import { callTool, missing, present, presentBrief } from '../tools';
import { fail, parseDate, parseTimestamp } from '../units';
import type { Workout } from '../workout';
import { parseChangeReason, parseComment, parseWorkout } from '../workout';

/** Addressed by the pair, resolved by the id alone: the date is ignored. See docs/api.md. */
type WorkoutRoute = '/api/workouts/:date(\\d{4}-\\d{2}-\\d{2})/:id([0-9a-z]+)';
type DateRoute = `${WorkoutRoute}/date`;
type CompletionRoute = `${WorkoutRoute}/complete`;
type CommentRoute = `${WorkoutRoute}/comment`;
type StatsRoute = `${WorkoutRoute}/stats`;
type RecordingRoute = `${WorkoutRoute}/recording`;

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

const createWorkout: AuthedRoute = async ({ request, url, env, user }) => {
  const workout = await plan.createWorkout(env, user, parseWorkout(await request.json()));
  return json(presentBrief(workout, url.origin), 201);
};

const getWorkout: AuthedRoute<WorkoutRoute> = async ({ url, env, user, params }) => {
  const workout = await db.getWorkout(env, user.id, params.id);
  return workout ? json(present(workout, url.origin)) : error(missing(params.id), 404);
};

/** The laps a workout row leaves off, for the reason `get_workout_stats` is its own tool. */
const getWorkoutStats: AuthedRoute<StatsRoute> = async ({ env, user, params }) => {
  // Both: the note is what says why the numbers look as they do. See the tool.
  const [stats, workout] = await Promise.all([
    db.getStats(env, user.id, params.id),
    db.getWorkout(env, user.id, params.id),
  ]);
  if (stats) return json({ ...stats, comment: workout?.comment ?? null });

  return error(workout ? `nothing has been recorded against ${params.id} yet` : missing(params.id), 404);
};

/** `2026-09-12-a1b2c3d4` -> the id in it. The day is required of the caller, and ignored. */
function idFromSlug(slug: string): string | null {
  if (slug.length < 12 || slug[10] !== '-') return null;
  const date = slug.slice(0, 10);
  const id = slug.slice(11);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[0-9a-z]+$/.test(id)) return null;
  return id;
}

/** The plan resolved: one duration and up to two targets a step, for a client that schedules it. */
const resolvedPlan = (workout: Workout) => ({
  date: workout.date,
  id: workout.id,
  name: workout.name,
  sport: workout.sport,
  sub_sport: workout.sub_sport ?? null,
  steps: resolveSteps(workout.steps),
});

/**
 * Every plan a client is about to schedule, in one round trip: a route addressed by one
 * workout cost a request, an authentication and a read each. Ids are `YYYY-MM-DD-<id>`,
 * and one naming the day a workout has left still finds it.
 *
 * A plan that is not there is named in `missing` rather than failing the batch — it may
 * have been deleted since the listing, which is the answer to the question.
 */
const getWorkoutPlans: AuthedRoute = async ({ url, env, user }) => {
  const asked = [
    ...new Set(
      (url.searchParams.get('plan-ids') ?? '')
        .split(',')
        .map((slug) => slug.trim())
        .filter((slug) => slug !== ''),
    ),
  ];
  if (asked.length === 0) {
    return error('plan-ids is required: a comma-separated list of YYYY-MM-DD-<id>', 400);
  }
  if (asked.length > db.MAX_WORKOUTS_PER_USER) {
    return error(
      `at most ${db.MAX_WORKOUTS_PER_USER} plan ids at a time, which is every workout there can be, ` +
        `but ${asked.length} were asked for`,
      400,
    );
  }

  const ids: string[] = [];
  const malformed: string[] = [];
  for (const slug of asked) {
    const id = idFromSlug(slug);
    if (id) ids.push(id);
    else malformed.push(slug);
  }
  if (malformed.length > 0) {
    return error(`expected each plan id as YYYY-MM-DD-<id>, got ${malformed.join(', ')}`, 400);
  }

  const workouts = await db.getWorkouts(env, user.id, ids);
  const found = new Set(workouts.map((workout) => workout.id));

  return json({
    plans: workouts.map(resolvedPlan),
    missing: asked.filter((slug) => !found.has(idFromSlug(slug) ?? slug)),
  });
};

/** The caller's own name for the file, so a session uploaded twice is recognisable as one. */
const activityId = (raw: string | null): string => {
  const id = (raw ?? '').trim();
  if (id.length > 100) fail('activity_id', 'must be at most 100 characters');
  return id || 'upload';
};

/**
 * The body is the FIT file, not JSON: an app holding one has the bytes, and base64 would
 * cost a third of the Worker's budget to wrap them. Read for their numbers and dropped.
 */
const recordWorkout: AuthedRoute<RecordingRoute> = async ({ request, url, env, user, params }) => {
  const tooBig = `a recording may be at most ${MAX_RECORDING_BYTES} bytes`;

  // Checked before the body is read as well as after: a client that declares its size
  // is refused without buffering a file the Worker was never going to decode.
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_RECORDING_BYTES) return error(tooBig, 413);

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_RECORDING_BYTES) return error(tooBig, 413);
  if (bytes.byteLength === 0) return error('the body is empty; post the FIT file itself', 400);

  const source = { platform: 'upload', activity_id: activityId(url.searchParams.get('activity_id')) };

  let recorded;
  try {
    recorded = await plan.recordSession(env, user, params.id, bytes, source);
  } catch (err) {
    // Unreadable is the caller's file, not our failure — and unlike the platform sync
    // there is nobody to retry, so it is answered rather than stored as a bad read.
    if (err instanceof StatsError) return error(err.message, 400);
    return error(`the recording could not be read: ${err instanceof Error ? err.message : String(err)}`, 400);
  }

  return recorded ? json(presentBrief(recorded.workout, url.origin)) : error(missing(params.id), 404);
};

const replaceWorkout: AuthedRoute<WorkoutRoute> = async ({ request, url, env, user, params }) => {
  // Taken out before the rest is parsed: it says why this write happened, not what the plan is.
  const { change_reason: reason, ...body } = (await request.json()) as Record<string, unknown>;
  const input = parseWorkout(body);

  const workout = await plan.replaceWorkout(env, user, params.id, input, parseChangeReason(reason));
  return workout ? json(presentBrief(workout, url.origin)) : error(missing(params.id), 404);
};

/** Its own verb, so moving a session to another day never means resending the plan. */
const moveWorkout: AuthedRoute<DateRoute> = async ({ request, url, env, user, params }) => {
  const body = (await request.json().catch(() => ({}))) as { date?: unknown; change_reason?: unknown };
  const date = parseDate(body?.date, 'date');

  const workout = await plan.moveWorkout(env, user, params.id, date, parseChangeReason(body?.change_reason));
  return workout ? json(presentBrief(workout, url.origin)) : error(missing(params.id), 404);
};

const deleteWorkout: AuthedRoute<WorkoutRoute> = async ({ env, user, params }) => {
  const deleted = await plan.deleteWorkout(env, user, params.id);
  return deleted
    ? json({ deleted: true, date: deleted.date, id: deleted.id })
    : error(missing(params.id), 404);
};

/** Its own verb, so marking a session done never means resending the plan. */
const setCompletion = async (
  context: Parameters<AuthedRoute<CompletionRoute>>[0],
  completedAt: string | null,
): Promise<Response> => {
  const { url, env, user, params } = context;
  const workout = await plan.setCompleted(env, user, params.id, completedAt);
  return workout ? json(presentBrief(workout, url.origin)) : error(missing(params.id), 404);
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

/** Its own verb too, and the one write here that travels out to the platform. */
const setComment = async (
  context: Parameters<AuthedRoute<CommentRoute>>[0],
  comment: string | null,
): Promise<Response> => {
  const { url, env, user, params } = context;
  const workout = await plan.setComment(env, user, params.id, comment);
  return workout ? json(presentBrief(workout, url.origin)) : error(missing(params.id), 404);
};

const commentWorkout: AuthedRoute<CommentRoute> = async (context) => {
  const body = (await context.request.json().catch(() => ({}))) as { comment?: unknown };
  return await setComment(context, parseComment(body?.comment));
};

const uncommentWorkout: AuthedRoute<CommentRoute> = (context) => setComment(context, null);

/** The MCP tools, reachable over plain REST. */
const runTool: AuthedRoute<'/api/tools/:name([a-z_]+)'> = async ({ request, url, env, user, params }) =>
  json(await callTool(params.name, await request.json(), env, user, url.origin));

const exportFit: AuthedRoute<'/export/:slug'> = async ({ env, user, params }) => {
  const id = idFromSlug(params.slug.replace(/\.fit$/, ''));
  if (!id) return error('expected /export/YYYY-MM-DD-<id>.fit', 400);

  const workout = await db.getWorkout(env, user.id, id);
  if (!workout) return error(missing(id), 404);

  return new Response(encodeWorkoutFit(workout), {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/vnd.ant.fit',
      'Content-Disposition': `attachment; filename="${fitFilename(workout)}"`,
      'Cache-Control': 'no-store',
    },
  });
};

export const routes = (app: Router<Context>): void => {
  app
    .get('/api/workout-plans', withUser(getWorkoutPlans))
    .get('/api/workouts', withUser(listWorkouts))
    .post('/api/workouts', withUser(createWorkout))
    .get(WORKOUT, withUser(getWorkout))
    .get(`${WORKOUT}/stats`, withUser(getWorkoutStats))
    .post(`${WORKOUT}/recording`, withUser(recordWorkout))
    .put(WORKOUT, withUser(replaceWorkout))
    .put(`${WORKOUT}/date`, withUser(moveWorkout))
    .delete(WORKOUT, withUser(deleteWorkout))
    .post(`${WORKOUT}/complete`, withUser(completeWorkout))
    .delete(`${WORKOUT}/complete`, withUser(uncompleteWorkout))
    .put(`${WORKOUT}/comment`, withUser(commentWorkout))
    .delete(`${WORKOUT}/comment`, withUser(uncommentWorkout))

    .post('/api/tools/:name([a-z_]+)', withUser(runTool))

    .get('/export/:slug', withUser(exportFit));
};
