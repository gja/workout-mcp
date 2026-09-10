/**
 * HTTP entry point: MCP at /mcp, a REST API at /api, FIT downloads at /export,
 * the OAuth endpoints MCP clients use to sign in, and the dashboard served
 * from the static assets binding.
 *
 * Two ways to authenticate, both resolving to the same user:
 *
 *   - a session cookie, for the dashboard and the OAuth consent page;
 *   - a bearer token, for MCP clients, the watch app and curl.
 */

import * as auth from './auth';
import * as db from './db';
import * as oauth from './oauth';
import type { Env, User } from './db';
import { encodeWorkoutFit, fitFilename } from './fit';
import { handleMcp } from './mcp';
import { ToolError, callTool, isCallerError, present } from './tools';
import { WorkoutError, normalizeWorkout } from './workout';
import { parseDate } from './units';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...CORS_HEADERS, ...headers } });

const error = (message: string, status: number): Response => json({ error: message }, status);

const appName = (env: Env): string => env.APP_NAME ?? 'Workouts';

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
// Login
// ---------------------------------------------------------------------------

/** The email/one-time-code endpoints. None of these need a credential. */
async function handleAuth(request: Request, url: URL, env: Env): Promise<Response | null> {
  const secure = url.protocol === 'https:';

  if (url.pathname === '/api/auth/request-code' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { email?: unknown };
    const result = await auth.requestLoginCode(env, body.email, appName(env));
    if (result.ok) return json({ sent: true, expires_in: auth.CODE_TTL_MINUTES * 60 });
    return json(
      { error: result.error },
      result.status,
      result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {},
    );
  }

  if (url.pathname === '/api/auth/verify' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { email?: unknown; code?: unknown };
    const result = await auth.verifyLoginCode(env, body.email, body.code);
    if (!result.ok) return json({ error: result.error }, result.status);

    const session = await auth.createSession(env, result.user.id);
    return json(result.user, 200, { 'Set-Cookie': auth.sessionCookie(session, secure) });
  }

  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    await auth.endSession(env, request);
    return json({ ok: true }, 200, { 'Set-Cookie': auth.sessionCookie(null, secure) });
  }

  return null;
}

/** Token management, which only a signed-in browser may do. */
async function handleTokens(request: Request, url: URL, env: Env, user: User): Promise<Response> {
  if (url.pathname === '/api/tokens') {
    if (request.method === 'GET') return json({ tokens: await auth.listTokens(env, user.id) });
    if (request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { name?: unknown };
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : null;
      const issued = await auth.issueToken(env, user.id, 'api', { name: name || 'API token' });
      // The only time the full token is ever returned.
      return json({ ...issued, note: 'Copy this now — it is stored only as a hash.' }, 201);
    }
    return error('method not allowed', 405);
  }

  const single = url.pathname.match(/^\/api\/tokens\/([A-Za-z0-9_]+)$/);
  if (single && request.method === 'DELETE') {
    return (await auth.revokeToken(env, user.id, single[1]))
      ? json({ revoked: true })
      : error('no such token', 404);
  }
  return error('not found', 404);
}

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

async function handleApi(request: Request, url: URL, env: Env, user: User, baseUrl: string): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/me') return json(user);

  // /api/workouts.json — the collection.
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
      const workout = await db.putWorkout(env, user.id, normalizeWorkout(await request.json()));
      return json(present(workout, baseUrl), 201);
    }
    return error('method not allowed', 405);
  }

  // /api/workouts/:date/:id.json — one workout.
  const single = path.match(/^\/api\/workouts\/(\d{4}-\d{2}-\d{2})\/([0-9a-z]+)(?:\.json)?$/);
  if (single) {
    const date = parseDate(single[1], 'date');
    const id = single[2];

    if (method === 'GET') {
      const workout = await db.getWorkout(env, user.id, date, id);
      return workout ? json(present(workout, baseUrl)) : error(`no workout ${id} on ${date}`, 404);
    }
    if (method === 'PUT') {
      if (!(await db.getWorkout(env, user.id, date, id))) return error(`no workout ${id} on ${date}`, 404);
      const input = normalizeWorkout(await request.json());
      if (input.date !== date) await db.deleteWorkout(env, user.id, date, id);
      return json(present(await db.putWorkout(env, user.id, input, id), baseUrl));
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
    return json(await callTool(tool[1], await request.json(), env, user, baseUrl));
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (url.pathname === '/api/health') return json({ ok: true, name: appName(env) });

    try {
      // --- Discovery, unauthenticated by definition.
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return oauth.protectedResourceMetadata(origin);
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return oauth.authorizationServerMetadata(origin);
      }
      if (url.pathname === '/oauth/register' && request.method === 'POST') {
        return await oauth.registerClient(request, env);
      }
      if (url.pathname === '/oauth/token' && request.method === 'POST') {
        return await oauth.token(request, env);
      }
      if (url.pathname === '/oauth/authorize' && request.method === 'GET') {
        return await oauth.authorize(request, url, env);
      }
      if (url.pathname === '/oauth/client' && request.method === 'GET') {
        return await oauth.describeClient(env, url.searchParams.get('client_id'));
      }

      // --- Login.
      const authResponse = await handleAuth(request, url, env);
      if (authResponse) return authResponse;

      // --- Everything past here needs a user.
      const needsUser =
        url.pathname === '/mcp' ||
        url.pathname === '/oauth/authorize' ||
        url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/export/');
      if (!needsUser) return env.ASSETS.fetch(request);

      const token = readToken(request, url);
      const user = token ? (await auth.findTokenOwner(env, token))?.user ?? null : await auth.readSession(env, request);

      if (!user) {
        // RFC 9728: point an MCP client at the metadata that starts the flow.
        const headers: Record<string, string> = {
          ...CORS_HEADERS,
          'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        };
        return Response.json({ error: token ? 'invalid or expired token' : 'not signed in' }, { status: 401, headers });
      }

      if (url.pathname === '/mcp') {
        if (request.method !== 'POST') return error('MCP requires POST', 405);
        const response = await handleMcp(request, env, user, origin);
        for (const [key, value] of Object.entries(CORS_HEADERS)) response.headers.set(key, value);
        return response;
      }
      if (url.pathname === '/oauth/authorize') return await oauth.grantAuthorization(request, env, user);
      if (url.pathname.startsWith('/api/tokens')) return await handleTokens(request, url, env, user);
      if (url.pathname.startsWith('/export/')) return await handleExport(url, env, user);
      return await handleApi(request, url, env, user, origin);
    } catch (err) {
      if (isCallerError(err)) return error(err.message, 400);
      if (err instanceof SyntaxError) return error('invalid JSON body', 400);
      console.error('unhandled error', err);
      return error('internal error', 500);
    }
  },

  /** Nightly sweep: retention, plus expired sessions, codes and tokens. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const workouts = await db.pruneAll(env);
    const credentials = await auth.pruneExpired(env);
    console.log(`nightly sweep removed ${workouts} workouts and ${credentials} expired credentials`);
  },
};

export { ToolError, WorkoutError };
