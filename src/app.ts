/**
 * Everything that is not the OAuth machinery: login, the consent page, the
 * REST API, FIT downloads, and the dashboard.
 *
 * This is the OAuth provider's `defaultHandler`, so it sees every request the
 * provider does not claim for itself. Requests here authenticate with a
 * session cookie or an API token; `/mcp` is handled separately, by the
 * provider, and reaches `src/index.ts` instead.
 *
 * This file is only the table: the context and `withUser` live in
 * `src/http.ts`, and each group of routes declares itself in `src/routes/`.
 */

import type { Env } from './db';
import { GarminAuthError } from './garmin/oauth';
import * as garmin from './garmin/routes';
import type { Context } from './http';
import { error, isApiPath, json, routablePath, withUser } from './http';
import { Router } from './router';
import type { Handler } from './router';
import * as account from './routes/account';
import * as oauth from './routes/oauth';
import * as signin from './routes/signin';
import * as sync from './routes/sync';
import * as workouts from './routes/workouts';
import { NotConnectedError, SyncBusyError } from './sync';
import { isCallerError } from './tools';

const appName = (env: Env): string => env.APP_NAME ?? 'Workouts';

/**
 * Under the API prefixes a fallback is answered the way a route would be: the
 * credential is checked first, so 401 comes before 404 or 405 and a caller
 * without one cannot map the API by reading status codes back.
 */
const guarded = (handler: Handler<Context>): Handler<Context> => {
  const behindTheDoor = withUser(handler);
  return (context) => (isApiPath(context.path) ? behindTheDoor(context) : handler(context));
};

const routes = new Router<Context>({
  methodNotAllowed: guarded(() => error('method not allowed', 405)),

  // Anything the table does not claim is the dashboard. Under the API
  // prefixes there is no dashboard to fall back to, only a 404.
  notFound: guarded((context) =>
    isApiPath(context.path) ? error('not found', 404) : context.env.ASSETS.fetch(context.request),
  ),
})
  .get('/api/health', ({ env }) => json({ ok: true, name: appName(env) }))
  .mount(signin.routes)
  .mount(oauth.routes)
  .mount(account.routes)
  .mount(workouts.routes)

  // Syncing is provider-neutral, so there is one group of it. Connecting is
  // not — every platform's consent flow, token shape and settings differ — so
  // each platform brings its own, and a second one is a sibling module and a
  // line here rather than a change to anything above.
  .mount(sync.routes)
  .mount(garmin.routes);

export const app = {
  // `ctx` is passed along so a write can schedule its own sync after the
  // response has gone: see `Context.background`. Optional, because the OAuth
  // provider calls this as its `defaultHandler` and a test may call it
  // directly — a write with nowhere to put the work still succeeds.
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const context: Context = { request, url, env, path: routablePath(url.pathname), background: ctx };

    try {
      return await routes.handle(request.method, context);
    } catch (err) {
      // Checked before the generic caller error below, which these are also
      // one of: an account not linked, a connection lapsed, or a sync already
      // in flight are all states of the world rather than bad requests, and
      // 409 says so where 400 would not.
      if (err instanceof GarminAuthError || err instanceof SyncBusyError || err instanceof NotConnectedError) {
        return error(err.message, 409);
      }
      if (isCallerError(err)) return error(err.message, 400);
      if (err instanceof SyntaxError) return error('invalid JSON body', 400);
      console.error('unhandled error', err);
      return error('internal error', 500);
    }
  },
} satisfies ExportedHandler<Env>;
