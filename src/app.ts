/**
 * Everything that is not the OAuth machinery: login, the consent page, the
 * REST API, FIT downloads, and the dashboard.
 *
 * This is the OAuth provider's `defaultHandler`, so it sees every request the
 * provider does not claim for itself. Requests here authenticate with a
 * session cookie or an API token; `/mcp` is handled separately, by the
 * provider, and reaches `src/index.ts` instead.
 *
 * Routing is the table at the bottom of the file. Each route is one handler,
 * and the ones behind `withUser` are handed the athlete they are acting for,
 * so no handler has to think about credentials.
 */

import { AuthorizationError } from '@cloudflare/workers-oauth-provider';
import * as auth from './auth';
import * as identity from './identity';
import * as db from './db';
import type { Env, User } from './db';
import { encodeWorkoutFit, fitFilename } from './fit';
import { Router } from './router';
import type { Handler } from './router';
import { callTool, isCallerError, present, presentBrief } from './tools';
import { parseWorkout } from './workout';
import { parseDate, parseTimestamp } from './units';

export const SCOPE = 'workouts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...CORS_HEADERS, ...headers } });

const error = (message: string, status: number): Response => json({ error: message }, status);

export const appName = (env: Env): string => env.APP_NAME ?? 'Workouts';

// ---------------------------------------------------------------------------
// The context every handler is given
// ---------------------------------------------------------------------------

/** What a route sees. `path` is what the table matched: see `routablePath`. */
type Context = {
  request: Request;
  url: URL;
  env: Env;
  path: string;
};

/** A route behind `withUser` also knows whose workouts it is touching. */
type AuthedContext = Context & { user: User };

/** Paths that are the API rather than the dashboard, and so are behind the door. */
const isApiPath = (path: string): boolean => path.startsWith('/api/') || path.startsWith('/export/');

/**
 * `.json` is a second spelling of an API path, for a browser or a `curl` that
 * wants to name the format. Stripping it here keeps each route declared once.
 */
const routablePath = (pathname: string): string => pathname.replace(/^(\/api\/.+)\.json$/, '$1');

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
const withUser =
  <Pattern extends string = string>(handler: Handler<AuthedContext, Pattern>): Handler<Context, Pattern> =>
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

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

/** Google's callback arrives in the query string, Apple's as a form body. */
async function callbackParams(request: Request, url: URL): Promise<URLSearchParams> {
  if (request.method !== 'POST') return url.searchParams;
  const form = await request.formData();
  const params = new URLSearchParams();
  for (const [key, value] of form) if (typeof value === 'string') params.set(key, value);
  return params;
}

/** `Response.redirect` gives an immutable response, so it has to be rebuilt. */
function withCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', cookie);
  return new Response(response.body, { status: response.status, headers });
}

/** A message for the dashboard to show after a failed sign-in. */
const backToDashboard = (origin: string, message?: string): Response =>
  Response.redirect(message ? `${origin}/?error=${encodeURIComponent(message)}` : `${origin}/`, 302);

/** Which buttons the dashboard should offer. */
const listProviders: Handler<Context> = ({ env, url }) =>
  json({ providers: identity.configuredProviders(env, url.origin) });

const startLogin: Handler<Context, '/auth/:provider/start'> = async ({ url, env, params }) => {
  if (!identity.isProviderName(params.provider)) return error(`unknown sign-in provider "${params.provider}"`, 404);
  try {
    const returnTo = url.searchParams.get('return_to');
    const { url: authorizationUrl, state } = await identity.startLogin(env, params.provider, url.origin, returnTo);
    // The state also goes to the browser, so the callback can prove it is
    // finishing the sign-in this browser started rather than someone else's.
    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizationUrl,
        'Set-Cookie': identity.loginCookie(state, url.protocol === 'https:'),
      },
    });
  } catch (err) {
    if (err instanceof identity.LoginError) return error(err.message, 400);
    throw err;
  }
};

const finishLogin: Handler<Context, '/auth/:provider/callback'> = async ({ request, url, env, params }) => {
  if (!identity.isProviderName(params.provider)) return error(`unknown sign-in provider "${params.provider}"`, 404);
  const secure = url.protocol === 'https:';

  // Google comes back as a redirect; Apple posts a form, cross-site.
  const callback = await callbackParams(request, url);
  const started = auth.readCookie(request, identity.LOGIN_COOKIE);
  // Spent either way, so a failed attempt cannot be retried against it.
  const clearLoginCookie = identity.loginCookie(null, secure);

  let who: identity.Identity;
  try {
    who = await identity.completeLogin(env, params.provider, callback, url.origin, started);
  } catch (err) {
    if (err instanceof identity.LoginError) {
      return withCookie(backToDashboard(url.origin, err.message), clearLoginCookie);
    }
    throw err;
  }

  // An unverified address is only a claim, and `ALLOWED_EMAILS` is an
  // authorization decision — so it is weighed as if no address were given,
  // which the allowlist refuses. The address is still stored for display.
  if (!auth.isAllowed(env, who.emailVerified ? who.email : null)) {
    return withCookie(
      backToDashboard(url.origin, 'that account is not allowed to sign in here'),
      clearLoginCookie,
    );
  }

  const user = await auth.upsertUser(env, who);
  const session = await auth.createSession(env, user.id);
  // 303, so the browser follows Apple's POST callback with a GET.
  const response = new Response(null, {
    status: 303,
    headers: {
      Location: `${url.origin}${who.returnTo ?? '/'}`,
      'Set-Cookie': auth.sessionCookie(session, secure),
    },
  });
  response.headers.append('Set-Cookie', clearLoginCookie);
  return response;
};

const logout: Handler<Context> = async ({ request, url, env }) => {
  await auth.endSession(env, request);
  return json({ ok: true }, 200, { 'Set-Cookie': auth.sessionCookie(null, url.protocol === 'https:') });
};

// ---------------------------------------------------------------------------
// OAuth consent
// ---------------------------------------------------------------------------

/**
 * The consent page. The provider owns /token and /register; the authorize
 * endpoint is ours, because only we know how to log someone in.
 *
 * A bad client_id or redirect_uri is reported here rather than redirected to —
 * an unvalidated redirect target is exactly what an attacker would want.
 * Everything else goes back to the client as an OAuth error.
 */
const showConsent: Handler<Context> = async ({ request, url, env }) => {
  try {
    await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    if (!(err instanceof AuthorizationError)) throw err;
    if (!err.redirectUri) return json({ error: err.code, error_description: err.description }, 400);

    const redirect = new URL(err.redirectUri);
    redirect.searchParams.set('error', err.code);
    redirect.searchParams.set('error_description', err.description);
    if (err.state) redirect.searchParams.set('state', err.state);
    if (err.issuer) redirect.searchParams.set('iss', err.issuer);
    return Response.redirect(redirect.toString(), 302);
  }

  return env.ASSETS.fetch(new Request(new URL('/authorize.html', url.origin), { headers: request.headers }));
};

/** The athlete has signed in and pressed Allow. */
const grantConsent: Handler<AuthedContext> = async ({ request, env, user }) => {
  let authRequest;
  try {
    // Re-parsed from the query string the consent page posted back, so the
    // grant is built from parameters the provider has just re-validated.
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    if (!(err instanceof AuthorizationError)) throw err;
    return json({ error: err.code, error_description: err.description }, 400);
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: user.id,
    metadata: { clientName: client?.clientName ?? 'An MCP client' },
    scope: authRequest.scope.length > 0 ? authRequest.scope : [SCOPE],
    props: { userId: user.id, email: user.email },
  });

  return json({ redirect: redirectTo });
};

/** So the consent page can say who is asking. */
const describeClient: Handler<Context> = async ({ url, env }) => {
  const client = await env.OAUTH_PROVIDER.lookupClient(url.searchParams.get('client_id') ?? '');
  return client
    ? json({ client_id: client.clientId, client_name: client.clientName ?? 'An MCP client' })
    : error('unknown client_id', 404);
};

// ---------------------------------------------------------------------------
// Tokens and connected apps
// ---------------------------------------------------------------------------

const listTokens: Handler<AuthedContext> = async ({ env, user }) =>
  json({ tokens: await auth.listTokens(env, user.id) });

const createToken: Handler<AuthedContext> = async ({ request, env, user }) => {
  const body = (await request.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : null;
  const issued = await auth.issueToken(env, user.id, name || 'API token');
  // The only time the full token is ever returned.
  return json({ ...issued, note: 'Copy this now — it is stored only as a hash.' }, 201);
};

const revokeToken: Handler<AuthedContext, '/api/tokens/:prefix'> = async ({ env, user, params }) =>
  (await auth.revokeToken(env, user.id, params.prefix)) ? json({ revoked: true }) : error('no such token', 404);

/** OAuth grants, which the provider stores in KV rather than D1. */
const listConnections: Handler<AuthedContext> = async ({ env, user }) => {
  const { items } = await env.OAUTH_PROVIDER.listUserGrants(user.id);
  return json({
    connections: items.map((grant) => ({
      id: grant.id,
      client_name: (grant.metadata as { clientName?: string } | null)?.clientName ?? 'An MCP client',
      scope: grant.scope,
      created_at: new Date(grant.createdAt * 1000).toISOString(),
    })),
  });
};

const revokeConnection: Handler<AuthedContext, '/api/connections/:id'> = async ({ env, user, params }) => {
  // Revoking a grant invalidates its access and refresh tokens together.
  await env.OAUTH_PROVIDER.revokeGrant(params.id, user.id);
  return json({ revoked: true });
};

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

// The window comes from the server because it is computed in UTC: a client
// deriving it from its own local midnight would disagree at the edges and
// drop a workout the server legitimately returned.
const whoAmI: Handler<AuthedContext> = ({ user }) => json({ ...user, window: db.retentionWindow() });

const listWorkouts: Handler<AuthedContext> = async ({ url, env, user }) => {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const workouts = await db.listWorkouts(
    env,
    user.id,
    from ? parseDate(from, 'from') : undefined,
    to ? parseDate(to, 'to') : undefined,
  );
  return json({ workouts: workouts.map((workout) => present(workout, url.origin)) });
};

const createWorkout: Handler<AuthedContext> = async ({ request, url, env, user }) => {
  const workout = await db.putWorkout(env, user.id, parseWorkout(await request.json()));
  return json(presentBrief(workout, url.origin), 201);
};

/** The `:date`/`:id` pair every single-workout route is addressed by. */
type WorkoutRoute = '/api/workouts/:date(\\d{4}-\\d{2}-\\d{2})/:id([0-9a-z]+)';

const getWorkout: Handler<AuthedContext, WorkoutRoute> = async ({ url, env, user, params }) => {
  const date = parseDate(params.date, 'date');
  const workout = await db.getWorkout(env, user.id, date, params.id);
  return workout ? json(present(workout, url.origin)) : error(`no workout ${params.id} on ${date}`, 404);
};

const replaceWorkout: Handler<AuthedContext, WorkoutRoute> = async ({ request, url, env, user, params }) => {
  const date = parseDate(params.date, 'date');
  const existing = await db.getWorkout(env, user.id, date, params.id);
  if (!existing) return error(`no workout ${params.id} on ${date}`, 404);

  const input = parseWorkout(await request.json());
  // Replacing the plan is not un-doing the session, and a move deletes the
  // row the completion would otherwise have been carried across from.
  if (existing.completed_at) input.completed_at = existing.completed_at;
  // Before the delete below, so a refused date does not also cost the
  // workout the caller was trying to move.
  db.assertRetainable(input.date);
  if (input.date !== date) await db.deleteWorkout(env, user.id, date, params.id);
  return json(presentBrief(await db.putWorkout(env, user.id, input, params.id), url.origin));
};

const deleteWorkout: Handler<AuthedContext, WorkoutRoute> = async ({ env, user, params }) => {
  const date = parseDate(params.date, 'date');
  const deleted = await db.deleteWorkout(env, user.id, date, params.id);
  return deleted ? json({ deleted: true, date, id: params.id }) : error(`no workout ${params.id} on ${date}`, 404);
};

/**
 * Completing a workout is its own verb rather than a field on the plan, so
 * marking a session done does not mean resending — or risk rewriting — it.
 */
const setCompletion = async (
  context: AuthedContext & { params: { date: string; id: string } },
  completedAt: string | null,
): Promise<Response> => {
  const { url, env, user, params } = context;
  const date = parseDate(params.date, 'date');
  const workout = await db.setCompleted(env, user.id, date, params.id, completedAt);
  return workout ? json(presentBrief(workout, url.origin)) : error(`no workout ${params.id} on ${date}`, 404);
};

type CompletionRoute = `${WorkoutRoute}/complete`;

const completeWorkout: Handler<AuthedContext, CompletionRoute> = async (context) => {
  // An empty body means now, which is the common case from the dashboard.
  const body = (await context.request.json().catch(() => ({}))) as { completed_at?: unknown };
  const completedAt =
    body?.completed_at === undefined || body.completed_at === null
      ? new Date().toISOString()
      : parseTimestamp(body.completed_at, 'completed_at');
  return await setCompletion(context, completedAt);
};

const uncompleteWorkout: Handler<AuthedContext, CompletionRoute> = (context) => setCompletion(context, null);

/** The MCP tools, reachable over plain REST. */
const runTool: Handler<AuthedContext, '/api/tools/:name([a-z_]+)'> = async ({ request, env, user, params }) =>
  json(await callTool(params.name, await request.json(), env, user));

const exportFit: Handler<AuthedContext, '/export/:slug'> = async ({ env, user, params }) => {
  const parts = splitDateId(params.slug.replace(/\.fit$/, ''));
  if (!parts) return error('expected /export/YYYY-MM-DD-<id>.fit', 400);

  const workout = await db.getWorkout(env, user.id, parts.date, parts.id);
  if (!workout) return error(`no workout ${parts.id} on ${parts.date}`, 404);

  return new Response(encodeWorkoutFit(workout), {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/vnd.ant.fit',
      'Content-Disposition': `attachment; filename="${fitFilename(workout)}"`,
      'Cache-Control': 'no-store',
    },
  });
};

/** `2026-09-12-a1b2c3d4` -> its parts. */
function splitDateId(slug: string): { date: string; id: string } | null {
  if (slug.length < 12 || slug[10] !== '-') return null;
  const date = slug.slice(0, 10);
  const id = slug.slice(11);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[0-9a-z]+$/.test(id)) return null;
  return { date, id };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const WORKOUT: WorkoutRoute = '/api/workouts/:date(\\d{4}-\\d{2}-\\d{2})/:id([0-9a-z]+)';

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

  .get('/auth/providers', listProviders)
  .get('/auth/:provider/start', startLogin)
  .on(['GET', 'POST'], '/auth/:provider/callback', finishLogin)
  .post('/api/auth/logout', logout)

  .get('/oauth/authorize', showConsent)
  .post('/oauth/authorize', withUser(grantConsent))
  .get('/oauth/client', describeClient)

  .get('/api/tokens', withUser(listTokens))
  .post('/api/tokens', withUser(createToken))
  .delete('/api/tokens/:prefix', withUser(revokeToken))

  .get('/api/connections', withUser(listConnections))
  .delete('/api/connections/:id', withUser(revokeConnection))

  .get('/api/me', withUser(whoAmI))
  .get('/api/workouts', withUser(listWorkouts))
  .post('/api/workouts', withUser(createWorkout))
  .get(WORKOUT, withUser(getWorkout))
  .put(WORKOUT, withUser(replaceWorkout))
  .delete(WORKOUT, withUser(deleteWorkout))
  .post(`${WORKOUT}/complete`, withUser(completeWorkout))
  .delete(`${WORKOUT}/complete`, withUser(uncompleteWorkout))
  .post('/api/tools/:name([a-z_]+)', withUser(runTool))

  .get('/export/:slug', withUser(exportFit));

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
