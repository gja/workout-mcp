/**
 * HTTP entry point: MCP at /mcp, a REST API at /api, FIT downloads at /export,
 * and the dashboard served from the static assets binding.
 *
 * Every request authenticates with a bearer token. Tokens are per-user and
 * carry no scopes — this is a single-purpose service for one athlete's plan.
 */

import * as db from './db';
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

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: CORS_HEADERS });

const error = (message: string, status: number): Response => json({ error: message }, status);

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

async function handleApi(request: Request, url: URL, env: Env, user: User, baseUrl: string): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/me') return json({ id: user.id, name: user.name });

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

/** Mint a user and token. Guarded by ADMIN_TOKEN, which is set as a secret. */
async function handleCreateUser(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN) return error('user creation is disabled: set the ADMIN_TOKEN secret', 403);
  const header = request.headers.get('Authorization');
  if (header !== `Bearer ${env.ADMIN_TOKEN}`) return error('unauthorized', 401);

  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const { user, token } = await db.createUser(env, body.name ?? null);
  return json({ id: user.id, name: user.name, token, note: 'Store this token now — it is not recoverable.' }, 201);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const baseUrl = url.origin;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (url.pathname === '/api/health') return json({ ok: true });
    if (url.pathname === '/api/users' && request.method === 'POST') return handleCreateUser(request, env);

    const needsAuth = url.pathname === '/mcp' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/export/');
    if (!needsAuth) return env.ASSETS.fetch(request);

    const token = readToken(request, url);
    if (!token) {
      // The WWW-Authenticate header is how an MCP client discovers it needs a token.
      return Response.json(
        { error: 'missing bearer token' },
        { status: 401, headers: { ...CORS_HEADERS, 'WWW-Authenticate': 'Bearer' } },
      );
    }
    const user = await db.findUserByToken(env, token);
    if (!user) return error('invalid token', 401);

    try {
      if (url.pathname === '/mcp') {
        if (request.method !== 'POST') return error('MCP requires POST', 405);
        const response = await handleMcp(request, env, user, baseUrl);
        for (const [key, value] of Object.entries(CORS_HEADERS)) response.headers.set(key, value);
        return response;
      }
      if (url.pathname.startsWith('/export/')) return await handleExport(url, env, user);
      return await handleApi(request, url, env, user, baseUrl);
    } catch (err) {
      if (isCallerError(err)) return error(err.message, 400);
      if (err instanceof SyntaxError) return error('invalid JSON body', 400);
      console.error('unhandled error', err);
      return error('internal error', 500);
    }
  },

  /** Nightly retention sweep, so abandoned accounts do not grow without bound. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const removed = await db.pruneAll(env);
    console.log(`retention sweep removed ${removed} workouts`);
  },
};

export { ToolError, WorkoutError };
