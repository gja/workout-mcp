// The integrations an athlete can turn on, in two namespaces: `/api/config` is what
// is set up, `/api/sync` is making it happen now. Syncing is an action, not a setting,
// so it does not live under config. What they do lives in `src/platforms/`.
//
// Google Drive was the other integration here and no longer has a surface: see
// "Retired" in docs/drive.md. `src/drive/` still runs on its own schedule for
// the drives already connected, but nothing routes to it.

import type { AuthedContext, AuthedRoute, Context } from '../http';
import { error, json, withUser } from '../http';
import * as platforms from '../platforms';
import type { Router } from '../router';

const CONFIG = '/api/config/:integration([a-z_]+)';
const SYNC = '/api/sync/:integration([a-z_]+)';

/** The params both namespaces carry. */
type Named = AuthedContext & { params: { integration: string } };

/** Everything the Setup panels render from, in one read. */
const readConfig: AuthedRoute = async ({ env, user }) =>
  json({
    credentials_configured: platforms.credentialsConfigured(env),
    platforms: await platforms.status(env, user),
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

// --- The table --------------------------------------------------------------

export const routes = (app: Router<Context>): void => {
  app
    .get('/api/config', withUser(readConfig))
    .put(CONFIG, withUser(connectPlatform))
    .delete(CONFIG, withUser(disconnectPlatform))
    .post(SYNC, withUser(syncPlatform));
};
