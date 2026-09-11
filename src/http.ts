/**
 * What every route shares: the context a handler is given, the shapes it
 * answers in, and `withUser` — the one place a credential becomes a `User`.
 *
 * The routes themselves live in `src/routes/`, a module per area, each
 * declaring its own paths. `src/app.ts` mounts them onto one router.
 *
 * There is deliberately no CORS here. Everything served through this table is
 * either same-origin (the dashboard fetching `/api/*` off the host that served
 * it) or not a browser at all (a watch app or curl holding a bearer token,
 * neither of which is subject to the same-origin policy). The one surface that
 * genuinely has cross-origin browser callers is `/mcp`, and that belongs to
 * `@cloudflare/workers-oauth-provider`: it answers the preflight and rewrites
 * `Access-Control-Allow-Origin` on the way out, for `/mcp` and for the OAuth
 * metadata, token and registration endpoints alike. Sending our own headers
 * under it achieved nothing but the appearance of a policy.
 */

import * as auth from './auth';
import type { Env, User } from './db';
import type { Handler } from './router';
import type { Background } from './sync';

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers });

export const error = (message: string, status: number): Response => json({ error: message }, status);

/** What a route sees. `path` is what the table matched: see `routablePath`. */
export type Context = {
  request: Request;
  url: URL;
  env: Env;
  path: string;
  /**
   * Somewhere to put work that should outlive the response.
   *
   * Optional because a handler is not entitled to assume it: the Worker
   * runtime supplies it, and a test or a direct call may not. A write that
   * cannot schedule its own sync still succeeds — it just waits for the night.
   */
  background?: Background;
};

/** A route behind `withUser` also knows whose workouts it is touching. */
export type AuthedContext = Context & { user: User };

/** A handler, and one that is only reached with an athlete in hand. */
export type Route<Pattern extends string = string> = Handler<Context, Pattern>;
export type AuthedRoute<Pattern extends string = string> = Handler<AuthedContext, Pattern>;

/** Paths that are the API rather than the dashboard, and so are behind the door. */
export const isApiPath = (path: string): boolean => path.startsWith('/api/') || path.startsWith('/export/');

/**
 * `.json` is a second spelling of an API path, for a browser or a `curl` that
 * wants to name the format. Stripping it here keeps each route declared once.
 */
export const routablePath = (pathname: string): string => pathname.replace(/^(\/api\/.+)\.json$/, '$1');

/**
 * The bearer token, from the Authorization header or — for FIT downloads only —
 * a `token` query parameter, since a watch or a plain link cannot set headers.
 */
function readToken({ request, url, path }: Context): string | null {
  const header = request.headers.get('Authorization');
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  if (path.startsWith('/export/')) return url.searchParams.get('token');
  return null;
}

/** RFC 9728: point a client at the metadata that starts the flow. */
const unauthenticated = (url: URL, hadToken: boolean): Response =>
  json({ error: hadToken ? 'invalid or expired token' : 'not signed in' }, 401, {
    'WWW-Authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"`,
  });

/**
 * Require an athlete, and inject them. The credential is either the dashboard's
 * session cookie or a bearer token from an MCP client or a watch.
 */
export const withUser =
  <Pattern extends string = string>(handler: AuthedRoute<Pattern>): Route<Pattern> =>
  async (context) => {
    const token = readToken(context);
    const user = token
      ? await auth.findTokenOwner(context.env, token)
      : await auth.readSession(context.env, context.request);
    if (!user) return unauthenticated(context.url, token !== null);
    // Awaited rather than returned, so a handler that rejects does so inside
    // this promise — a bare `return` adopts it a tick later, by which point
    // the runtime has already called the rejection unhandled.
    return await handler({ ...context, user });
  };

/**
 * Require an athlete, and send them to sign in if there is none.
 *
 * For the browser journeys — connecting a watch platform — where the athlete
 * is walked out to a third party and back. A JSON 401 at the end of that is
 * something they can neither read nor act on; the dashboard, with a message,
 * is both. Session cookie only, deliberately: a bearer token belongs to an
 * MCP client, which has no browser to complete a consent screen in.
 */
export const withUserOrSignIn =
  <Pattern extends string = string>(handler: AuthedRoute<Pattern>): Route<Pattern> =>
  async (context) => {
    const user = await auth.readSession(context.env, context.request);
    if (!user) {
      return Response.redirect(
        `${context.url.origin}/?error=${encodeURIComponent('please sign in before connecting a watch platform')}`,
        302,
      );
    }
    return await handler({ ...context, user });
  };
