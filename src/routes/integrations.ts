// The integrations an athlete can turn on, in two namespaces: `/api/config` is what
// is set up, `/api/sync` is making it happen now. Syncing is an action, not a setting,
// so it does not live under config. What they do lives in `src/platforms/` and `src/drive/`.

import * as drive from '../drive';
import type { AuthedContext, AuthedRoute, Context } from '../http';
import { error, json, withUser } from '../http';
import * as platforms from '../platforms';
import type { Router } from '../router';

const CONFIG = '/api/config/:integration([a-z_]+)';
const SYNC = '/api/sync/:integration([a-z_]+)';

/** Not a training platform, so it is dispatched by name rather than found in `PLATFORMS`. */
const DRIVE = 'drive';

/** The params both namespaces carry. */
type Named = AuthedContext & { params: { integration: string } };

/** Everything the Setup panels render from, in one read. */
const readConfig: AuthedRoute = async ({ env, user }) =>
  json({
    credentials_configured: platforms.credentialsConfigured(env),
    platforms: await platforms.status(env, user),
    drive: await drive.status(env, user),
  });

// --- Training platforms -----------------------------------------------------

/** The platform the path named, or a 404 response to return instead. */
const namedPlatform = (name: string): platforms.PlatformId | Response =>
  platforms.isPlatformId(name) ? name : error(`unknown integration "${name}"`, 404);

/**
 * There is nothing to PUT: a platform is connected by an OAuth round, not a body.
 *
 * Kept as an answer rather than a 404, because it used to take a pasted API key and
 * anything still sending one deserves to be told where the door moved to.
 */
const connectPlatform = async ({ params }: Named) => {
  const platform = namedPlatform(params.integration);
  if (platform instanceof Response) return platform;
  return error(`connect ${platform} from the dashboard: it is an OAuth app, and there is no key to paste`, 400);
};

const disconnectPlatform = async ({ env, user, params }: Named) => {
  const platform = namedPlatform(params.integration);
  if (platform instanceof Response) return platform;
  return (await platforms.disconnect(env, user, platform))
    ? json({ disconnected: true })
    : error('that integration is not connected', 404);
};

/** Push anything out of date and read completions back, on demand. */
const syncPlatform = async ({ env, user, params }: Named) => {
  const platform = namedPlatform(params.integration);
  if (platform instanceof Response) return platform;
  return json(await platforms.syncNow(env, user, platform));
};

// --- Google Drive -----------------------------------------------------------

/** The first copy runs straight away: a drive that fills in an hour later looks broken. */
const connectDrive = async ({ request, env, user }: AuthedContext) => {
  const body = (await request.json().catch(() => ({}))) as { drive?: unknown };
  const pasted = typeof body.drive === 'string' ? body.drive.trim() : '';
  if (!pasted) return error('drive is required', 400);

  try {
    const found = await drive.configure(env, user, pasted);
    return json({ connected: true, drive_id: found.id, drive_name: found.name, sync: await drive.copyNow(env, user) });
  } catch (err) {
    if (err instanceof drive.DriveUnavailable) return error(err.message, 503);
    if (err instanceof drive.DriveError) return error(err.message, 400);
    throw err;
  }
};

const disconnectDrive = async ({ env, user }: AuthedContext) =>
  (await drive.forget(env, user)) ? json({ disconnected: true }) : error('no drive is configured', 404);

const syncDrive = async ({ env, user }: AuthedContext) => json(await drive.copyNow(env, user));

// --- The table --------------------------------------------------------------

// Dispatched on the name rather than left to two patterns and the order they were
// declared in, so `drive` cannot start resolving to the platform route on a reshuffle.
// Typed on the params both namespaces share, so one pair of handlers serves both.
const byIntegration =
  (forDrive: (context: AuthedContext) => Promise<Response>, forPlatform: (context: Named) => Promise<Response>) =>
  (context: Named): Promise<Response> =>
    context.params.integration === DRIVE ? forDrive(context) : forPlatform(context);

export const routes = (app: Router<Context>): void => {
  app
    .get('/api/config', withUser(readConfig))
    .put(CONFIG, withUser(byIntegration(connectDrive, connectPlatform)))
    .delete(CONFIG, withUser(byIntegration(disconnectDrive, disconnectPlatform)))
    .post(SYNC, withUser(byIntegration(syncDrive, syncPlatform)));
};
