/**
 * Everything that is not the OAuth machinery: login, the consent page, the
 * REST API, FIT downloads, and the dashboard.
 *
 * This is the OAuth provider's `defaultHandler`, so it sees every request the
 * provider does not claim for itself. Requests here authenticate with a
 * session cookie or an API token; `/mcp` is handled separately, by the
 * provider, and reaches `src/index.ts` instead.
 */

import { AuthorizationError } from '@cloudflare/workers-oauth-provider';
import * as auth from './auth';
import * as identity from './identity';
import * as db from './db';
import type { Env, User } from './db';
import { encodeWorkoutFit, fitFilename } from './fit';
import { callTool, isCallerError, present, presentBrief } from './tools';
import { parseWorkout } from './workout';
import { parseDate, parseTimestamp } from './units';

export const SCOPE = 'workouts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...CORS_HEADERS, ...headers } });

const error = (message: string, status: number): Response => json({ error: message }, status);

export const appName = (env: Env): string => env.APP_NAME ?? 'Workouts';

/**
 * The bearer token, from the Authorization header or — for FIT downloads only —
 * a `token` query parameter, since a watch or a plain link cannot set headers.
 */
function readToken(request: Request, url: URL): string | null {
  const header = request.headers.get('Authorization');
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  if (url.pathname.startsWith('/export/')) return url.searchParams.get('token');
  return null;
}

/** `2026-09-12-a1b2c3d4` -> its parts. */
function splitDateId(slug: string): { date: string; id: string } | null {
  if (slug.length < 12 || slug[10] !== '-') return null;
  const date = slug.slice(0, 10);
  const id = slug.slice(11);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[0-9a-z]+$/.test(id)) return null;
  return { date, id };
}

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

async function handleSignIn(request: Request, url: URL, env: Env): Promise<Response | null> {
  const secure = url.protocol === 'https:';

  // Which buttons the dashboard should offer.
  if (url.pathname === '/auth/providers' && request.method === 'GET') {
    return json({ providers: identity.configuredProviders(env, url.origin) });
  }

  const start = url.pathname.match(/^\/auth\/([a-z]+)\/start$/);
  if (start && request.method === 'GET') {
    if (!identity.isProviderName(start[1])) return error(`unknown sign-in provider "${start[1]}"`, 404);
    try {
      const returnTo = url.searchParams.get('return_to');
      const { url: authorizationUrl, state } = await identity.startLogin(env, start[1], url.origin, returnTo);
      // The state also goes to the browser, so the callback can prove it is
      // finishing the sign-in this browser started rather than someone else's.
      return new Response(null, {
        status: 302,
        headers: { Location: authorizationUrl, 'Set-Cookie': identity.loginCookie(state, secure) },
      });
    } catch (err) {
      if (err instanceof identity.LoginError) return error(err.message, 400);
      throw err;
    }
  }

  const callback = url.pathname.match(/^\/auth\/([a-z]+)\/callback$/);
  if (callback && (request.method === 'GET' || request.method === 'POST')) {
    if (!identity.isProviderName(callback[1])) return error(`unknown sign-in provider "${callback[1]}"`, 404);

    // Google comes back as a redirect; Apple posts a form, cross-site.
    const params = await callbackParams(request, url);
    const started = auth.readCookie(request, identity.LOGIN_COOKIE);
    // Spent either way, so a failed attempt cannot be retried against it.
    const clearLoginCookie = identity.loginCookie(null, secure);

    let who: identity.Identity;
    try {
      who = await identity.completeLogin(env, callback[1], params, url.origin, started);
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
  }

  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    await auth.endSession(env, request);
    return json({ ok: true }, 200, { 'Set-Cookie': auth.sessionCookie(null, secure) });
  }

  return null;
}

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
async function showConsent(request: Request, url: URL, env: Env): Promise<Response> {
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
}

/** The athlete has signed in and pressed Allow. */
async function grantConsent(request: Request, env: Env, user: User): Promise<Response> {
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
}

// ---------------------------------------------------------------------------
// Tokens and connected apps
// ---------------------------------------------------------------------------

async function handleTokens(request: Request, url: URL, env: Env, user: User): Promise<Response> {
  if (url.pathname === '/api/tokens') {
    if (request.method === 'GET') return json({ tokens: await auth.listTokens(env, user.id) });
    if (request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { name?: unknown };
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : null;
      const issued = await auth.issueToken(env, user.id, name || 'API token');
      // The only time the full token is ever returned.
      return json({ ...issued, note: 'Copy this now — it is stored only as a hash.' }, 201);
    }
    return error('method not allowed', 405);
  }

  const single = url.pathname.match(/^\/api\/tokens\/([A-Za-z0-9_]+)$/);
  if (single && request.method === 'DELETE') {
    return (await auth.revokeToken(env, user.id, single[1])) ? json({ revoked: true }) : error('no such token', 404);
  }
  return error('not found', 404);
}

/** OAuth grants, which the provider stores in KV rather than D1. */
async function handleConnections(request: Request, url: URL, env: Env, user: User): Promise<Response> {
  if (url.pathname === '/api/connections' && request.method === 'GET') {
    const { items } = await env.OAUTH_PROVIDER.listUserGrants(user.id);
    return json({
      connections: items.map((grant) => ({
        id: grant.id,
        client_name: (grant.metadata as { clientName?: string } | null)?.clientName ?? 'An MCP client',
        scope: grant.scope,
        created_at: new Date(grant.createdAt * 1000).toISOString(),
      })),
    });
  }

  const single = url.pathname.match(/^\/api\/connections\/([A-Za-z0-9_-]+)$/);
  if (single && request.method === 'DELETE') {
    // Revoking a grant invalidates its access and refresh tokens together.
    await env.OAUTH_PROVIDER.revokeGrant(single[1], user.id);
    return json({ revoked: true });
  }
  return error('not found', 404);
}

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

async function handleApi(request: Request, url: URL, env: Env, user: User, baseUrl: string): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  // The window comes from the server because it is computed in UTC: a client
  // deriving it from its own local midnight would disagree at the edges and
  // drop a workout the server legitimately returned.
  if (path === '/api/me') return json({ ...user, window: db.retentionWindow() });

  if (path === '/api/workouts' || path === '/api/workouts.json') {
    if (method === 'GET') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const workouts = await db.listWorkouts(
        env,
        user.id,
        from ? parseDate(from, 'from') : undefined,
        to ? parseDate(to, 'to') : undefined,
      );
      return json({ workouts: workouts.map((w) => present(w, baseUrl)) });
    }
    if (method === 'POST') {
      const workout = await db.putWorkout(env, user.id, parseWorkout(await request.json()));
      return json(presentBrief(workout, baseUrl), 201);
    }
    return error('method not allowed', 405);
  }

  // Completing a workout is its own verb rather than a field on the plan, so
  // marking a session done does not mean resending — or risk rewriting — it.
  const completion = path.match(/^\/api\/workouts\/(\d{4}-\d{2}-\d{2})\/([0-9a-z]+)\/complete$/);
  if (completion) {
    const date = parseDate(completion[1], 'date');
    const id = completion[2];

    if (method === 'POST' || method === 'DELETE') {
      // An empty body means now, which is the common case from the dashboard.
      const body = method === 'POST' ? ((await request.json().catch(() => ({}))) as { completed_at?: unknown }) : {};
      const completedAt =
        method === 'DELETE'
          ? null
          : body?.completed_at === undefined || body.completed_at === null
            ? new Date().toISOString()
            : parseTimestamp(body.completed_at, 'completed_at');

      const workout = await db.setCompleted(env, user.id, date, id, completedAt);
      return workout ? json(presentBrief(workout, baseUrl)) : error(`no workout ${id} on ${date}`, 404);
    }
    return error('method not allowed', 405);
  }

  const single = path.match(/^\/api\/workouts\/(\d{4}-\d{2}-\d{2})\/([0-9a-z]+)(?:\.json)?$/);
  if (single) {
    const date = parseDate(single[1], 'date');
    const id = single[2];

    if (method === 'GET') {
      const workout = await db.getWorkout(env, user.id, date, id);
      return workout ? json(present(workout, baseUrl)) : error(`no workout ${id} on ${date}`, 404);
    }
    if (method === 'PUT') {
      const existing = await db.getWorkout(env, user.id, date, id);
      if (!existing) return error(`no workout ${id} on ${date}`, 404);
      const input = parseWorkout(await request.json());
      // Replacing the plan is not un-doing the session, and a move deletes the
      // row the completion would otherwise have been carried across from.
      if (existing.completed_at) input.completed_at = existing.completed_at;
      // Before the delete below, so a refused date does not also cost the
      // workout the caller was trying to move.
      db.assertRetainable(input.date);
      if (input.date !== date) await db.deleteWorkout(env, user.id, date, id);
      return json(presentBrief(await db.putWorkout(env, user.id, input, id), baseUrl));
    }
    if (method === 'DELETE') {
      const deleted = await db.deleteWorkout(env, user.id, date, id);
      return deleted ? json({ deleted: true, date, id }) : error(`no workout ${id} on ${date}`, 404);
    }
    return error('method not allowed', 405);
  }

  // /api/tools/:name — the MCP tools, reachable over plain REST.
  const tool = path.match(/^\/api\/tools\/([a-z_]+)$/);
  if (tool) {
    if (method !== 'POST') return error('method not allowed', 405);
    return json(await callTool(tool[1], await request.json(), env, user));
  }

  return error('not found', 404);
}

async function handleExport(url: URL, env: Env, user: User): Promise<Response> {
  const slug = url.pathname.slice('/export/'.length).replace(/\.fit$/, '');
  const parts = splitDateId(slug);
  if (!parts) return error('expected /export/YYYY-MM-DD-<id>.fit', 400);

  const workout = await db.getWorkout(env, user.id, parts.date, parts.id);
  if (!workout) return error(`no workout ${parts.id} on ${parts.date}`, 404);

  const bytes = encodeWorkoutFit(workout);
  return new Response(bytes, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/vnd.ant.fit',
      'Content-Disposition': `attachment; filename="${fitFilename(workout)}"`,
      'Cache-Control': 'no-store',
    },
  });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export const app = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (url.pathname === '/api/health') return json({ ok: true, name: appName(env) });

    try {
      if (url.pathname === '/oauth/authorize' && request.method === 'GET') return await showConsent(request, url, env);
      if (url.pathname === '/oauth/client' && request.method === 'GET') {
        const client = await env.OAUTH_PROVIDER.lookupClient(url.searchParams.get('client_id') ?? '');
        return client
          ? json({ client_id: client.clientId, client_name: client.clientName ?? 'An MCP client' })
          : error('unknown client_id', 404);
      }

      const signInResponse = await handleSignIn(request, url, env);
      if (signInResponse) return signInResponse;

      const needsUser =
        url.pathname === '/oauth/authorize' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/export/');
      if (!needsUser) return env.ASSETS.fetch(request);

      const token = readToken(request, url);
      const user = token ? await auth.findTokenOwner(env, token) : await auth.readSession(env, request);
      if (!user) {
        return Response.json(
          { error: token ? 'invalid or expired token' : 'not signed in' },
          {
            status: 401,
            // RFC 9728: point a client at the metadata that starts the flow.
            headers: {
              ...CORS_HEADERS,
              'WWW-Authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"`,
            },
          },
        );
      }

      if (url.pathname === '/oauth/authorize') return await grantConsent(request, env, user);
      if (url.pathname.startsWith('/api/tokens')) return await handleTokens(request, url, env, user);
      if (url.pathname.startsWith('/api/connections')) return await handleConnections(request, url, env, user);
      if (url.pathname.startsWith('/export/')) return await handleExport(url, env, user);
      return await handleApi(request, url, env, user, url.origin);
    } catch (err) {
      if (isCallerError(err)) return error(err.message, 400);
      if (err instanceof SyntaxError) return error('invalid JSON body', 400);
      console.error('unhandled error', err);
      return error('internal error', 500);
    }
  },
} satisfies ExportedHandler<Env>;
