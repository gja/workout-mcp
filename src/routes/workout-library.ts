// The workout library: one document per athlete, read by the assistant and edited here.

import type { AuthedRoute, Context } from '../http';
import { json, withUser } from '../http';
import type { Router } from '../router';
import * as workoutLibrary from '../workout-library';

const readLibrary: AuthedRoute = async ({ env, user }) => json(await workoutLibrary.readLibrary(env, user.id));

const saveLibrary: AuthedRoute = async ({ request, env, user }) => {
  const body = (await request.json()) as { markdown?: unknown };
  return json(await workoutLibrary.saveLibrary(env, user.id, body?.markdown));
};

const resetLibrary: AuthedRoute = async ({ env, user }) => json(await workoutLibrary.resetLibrary(env, user.id));

export const routes = (app: Router<Context>): void => {
  app
    .get('/api/workout-library', withUser(readLibrary))
    .put('/api/workout-library', withUser(saveLibrary))
    .delete('/api/workout-library', withUser(resetLibrary));
};
