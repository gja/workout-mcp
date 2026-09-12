// The provider's `defaultHandler`, and only the routing table: the groups live in `src/routes/`.

import type { Env } from './db';
import type { Context } from './http';
import { CORS_HEADERS, error, isApiPath, json, routablePath, withUser } from './http';
import { Router } from './router';
import type { Handler } from './router';
import * as account from './routes/account';
import * as integrations from './routes/integrations';
import * as oauth from './routes/oauth';
import * as recordings from './routes/recordings';
import * as signin from './routes/signin';
import * as webhooks from './routes/webhooks';
import * as workouts from './routes/workouts';
import { isCallerError } from './tools';

const appName = (env: Env): string => env.APP_NAME ?? 'Workouts';

/**
 * A path with no file behind it, answered with the page it belongs to: the client
 * reads the path back off `location`. Only pages that exist as a file — `/` and
 * `/privacy-policy` — are served by the assets binding on their own.
 */
const page =
  (asset: string): Handler<Context> =>
  ({ request, url, env }) =>
    env.ASSETS.fetch(new Request(new URL(asset, url), request));

/** 401 before 404 or 405, so the API cannot be mapped by reading status codes back. */
const guarded = (handler: Handler<Context>): Handler<Context> => {
  const behindTheDoor = withUser(handler);
  return (context) => (isApiPath(context.path) ? behindTheDoor(context) : handler(context));
};

const routes = new Router<Context>({
  methodNotAllowed: guarded(() => error('method not allowed', 405)),

  // Anything unclaimed is the dashboard — except under the API prefixes, where it is a 404.
  notFound: guarded((context) =>
    isApiPath(context.path) ? error('not found', 404) : context.env.ASSETS.fetch(context.request),
  ),
})
  .get('/api/health', ({ env }) => json({ ok: true, name: appName(env) }))

  // A link straight to one session; the dashboard opens it once the list loads.
  .get('/workout/:id', page('/'))

  .mount(signin.routes)
  .mount(oauth.routes)
  .mount(account.routes)
  .mount(integrations.routes)
  .mount(webhooks.routes)
  .mount(recordings.routes)
  .mount(workouts.routes);

export const app = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    const url = new URL(request.url);
    const context: Context = { request, url, env, path: routablePath(url.pathname) };

    try {
      return await routes.handle(request.method, context);
    } catch (err) {
      if (isCallerError(err)) return error(err.message, 400);
      if (err instanceof SyntaxError) return error('invalid JSON body', 400);
      console.error('unhandled error', err);
      return error('internal error', 500);
    }
  },
} satisfies ExportedHandler<Env>;
