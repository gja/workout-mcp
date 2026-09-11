/**
 * Putting the plan where the athlete's watch will see it.
 *
 * One route, and provider-neutral on purpose: the dashboard and the MCP tool
 * both want "sync my workouts", not "talk to Garmin". Every platform the
 * athlete has linked is synced, and the report says what each one did.
 *
 * Connecting an account is the half that is *not* generalised, and lives under
 * the provider's own routes — `src/garmin/routes.ts` for the first of them.
 * Every platform's consent flow, token shape and settings differ, so a shared
 * `/api/connect` would be a shape with one implementation pretending to be an
 * abstraction.
 */

import type { AuthedRoute, Context } from '../http';
import { json, withUser } from '../http';
import type { Router } from '../router';
import { syncNow } from '../sync';

/** `POST /api/sync` — `{dry_run, force}`, both optional. */
const syncEverything: AuthedRoute = async ({ request, url, env, user }) => {
  const body = (await request.json().catch(() => ({}))) as { dry_run?: unknown; force?: unknown };
  return json(await syncNow(env, user.id, { dryRun: body.dry_run === true, force: body.force === true }, url.origin));
};

export const routes = (app: Router<Context>): void => {
  app.post('/api/sync', withUser(syncEverything));
};
