/**
 * Connecting a training platform, and syncing with it.
 *
 * Only the HTTP shape lives here. What a platform is, and what a create, an
 * update or a delete means to one, is `src/platforms/`; the writes themselves
 * reach it through `src/plan.ts`, not through these routes.
 */

import type { AuthedRoute, Context } from '../http';
import { error, json, withUser } from '../http';
import * as platforms from '../platforms';
import type { Router } from '../router';

type PlatformRoute = '/api/platforms/:platform([a-z_]+)';

const PLATFORM: PlatformRoute = '/api/platforms/:platform([a-z_]+)';

/**
 * Every platform we can sync to, and where each one stands for this athlete.
 * Unconnected ones are listed too, so the dashboard can offer them.
 */
const listPlatforms: AuthedRoute = async ({ env, user }) =>
  json({ configured: platforms.credentialsConfigured(env), platforms: await platforms.status(env, user) });

/** The platform the path named, or a 404 response to return instead. */
const namedPlatform = (name: string): platforms.PlatformId | Response =>
  platforms.isPlatformId(name) ? name : error(`unknown platform "${name}"`, 404);

/**
 * Connect a platform by storing the athlete's key, then push what we have.
 *
 * The key is checked against the platform before it is stored, so a typo is a
 * 400 here rather than an error that only shows up on the next workout. The
 * first sync runs straight away: a calendar that fills in only when the next
 * workout happens to be written would look broken.
 */
const connectPlatform: AuthedRoute<PlatformRoute> = async ({ request, env, user, params }) => {
  const platform = namedPlatform(params.platform);
  if (platform instanceof Response) return platform;

  const body = (await request.json().catch(() => ({}))) as { key?: unknown };
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) return error('key is required', 400);

  try {
    const account = await platforms.connect(env, user, platform, key);
    return json({
      connected: true,
      account: account.name ?? account.id,
      sync: await platforms.syncNow(env, user, platform),
    });
  } catch (err) {
    if (err instanceof platforms.CredentialsUnavailable) return error(err.message, 503);
    if (err instanceof platforms.PlatformError) return error(err.message, 400);
    throw err;
  }
};

const disconnectPlatform: AuthedRoute<PlatformRoute> = async ({ env, user, params }) => {
  const platform = namedPlatform(params.platform);
  if (platform instanceof Response) return platform;
  return (await platforms.disconnect(env, user, platform))
    ? json({ disconnected: true })
    : error('that platform is not connected', 404);
};

/** Push anything out of date and read completions back, on demand. */
const syncPlatform: AuthedRoute<`${PlatformRoute}/sync`> = async ({ env, user, params }) => {
  const platform = namedPlatform(params.platform);
  if (platform instanceof Response) return platform;
  return json(await platforms.syncNow(env, user, platform));
};

export const routes = (app: Router<Context>): void => {
  app
    .get('/api/platforms', withUser(listPlatforms))
    .put(PLATFORM, withUser(connectPlatform))
    .delete(PLATFORM, withUser(disconnectPlatform))
    .post(`${PLATFORM}/sync`, withUser(syncPlatform));
};
