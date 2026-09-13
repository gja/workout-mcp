// The workout library: one document per athlete, read by the assistant and edited here.

import type { AuthedRoute, Context } from '../http';
import { json, withUser } from '../http';
import * as library from '../library';
import type { Router } from '../router';

const readLibrary: AuthedRoute = async ({ env, user }) => json(await library.readLibrary(env, user.id));

const saveLibrary: AuthedRoute = async ({ request, env, user }) => {
  const body = (await request.json()) as { markdown?: unknown };
  return json(await library.saveLibrary(env, user.id, body?.markdown));
};

const resetLibrary: AuthedRoute = async ({ env, user }) => json(await library.resetLibrary(env, user.id));

export const routes = (app: Router<Context>): void => {
  app
    .get('/api/library', withUser(readLibrary))
    .put('/api/library', withUser(saveLibrary))
    .delete('/api/library', withUser(resetLibrary));
};
