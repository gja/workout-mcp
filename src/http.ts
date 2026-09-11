/**
 * What every route shares: the context a handler is given, the shapes it
 * answers in, and `withUser` — the one place a credential becomes a `User`.
 *
 * The routes themselves live in `src/routes/`, a module per area, each
 * declaring its own paths. `src/app.ts` mounts them onto one router.
 */

import * as auth from './auth';
import type { Env, User } from './db';
import type { Handler } from './router';

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...CORS_HEADERS, ...headers } });

export const error = (message: string, status: number): Response => json({ error: message }, status);

/** What a route sees. `path` is what the table matched: see `routablePath`. */
export type Context = {
  request: Request;
  url: URL;
  env: Env;
  path: string;
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
