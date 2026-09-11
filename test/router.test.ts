import { describe, expect, it } from 'vitest';
import { Router } from '../src/router';

type Context = { path: string; seen: string[] };

const text = (body: string, status = 200) => new Response(body, { status });

/** A router that records which fallback it reached, so both can be asserted. */
const router = () =>
  new Router<Context>({
    methodNotAllowed: () => text('method not allowed', 405),
    notFound: () => text('not found', 404),
  });

const call = async (
  built: Router<Context>,
  method: string,
  path: string,
): Promise<{ status: number; body: string }> => {
  const response = await built.handle(method, { path, seen: [] });
  return { status: response.status, body: await response.text() };
};

describe('the router', () => {
  it('matches a literal path and its method', async () => {
    const routes = router().get('/api/health', () => text('ok'));

    expect(await call(routes, 'GET', '/api/health')).toEqual({ status: 200, body: 'ok' });
  });

  it('tells a missing route apart from a missing method', async () => {
    const routes = router()
      .get('/api/workouts', () => text('list'))
      .post('/api/workouts', () => text('created', 201));

    expect((await call(routes, 'DELETE', '/api/workouts')).status).toBe(405);
    expect((await call(routes, 'GET', '/api/elsewhere')).status).toBe(404);
  });

  it('hands the named segments to the handler', async () => {
    const routes = router().get('/auth/:provider/start', ({ params }) => text(params.provider));

    expect((await call(routes, 'GET', '/auth/google/start')).body).toBe('google');
    // A parameter is one segment, so a nested path is a different route.
    expect((await call(routes, 'GET', '/auth/a/b/start')).status).toBe(404);
  });

  it('holds a parameter to its constraint, so nonsense is a 404 not a handler', async () => {
    const routes = router().get('/api/workouts/:date(\\d{4}-\\d{2}-\\d{2})/:id([0-9a-z]+)', ({ params }) =>
      text(`${params.date}/${params.id}`),
    );

    expect((await call(routes, 'GET', '/api/workouts/2026-09-12/a1b2c3d4')).body).toBe('2026-09-12/a1b2c3d4');
    expect((await call(routes, 'GET', '/api/workouts/yesterday/a1b2c3d4')).status).toBe(404);
    expect((await call(routes, 'GET', '/api/workouts/2026-09-12/UPPER')).status).toBe(404);
  });

  it('treats a literal pattern as literal, not as a regular expression', async () => {
    const routes = router().get('/api/auth.logout', () => text('logged out'));

    expect((await call(routes, 'GET', '/api/auth.logout')).status).toBe(200);
    expect((await call(routes, 'GET', '/api/authXlogout')).status).toBe(404);
  });

  it('takes the first route that matches', async () => {
    const routes = router()
      .get('/api/tokens/mine', () => text('mine'))
      .get('/api/tokens/:prefix', ({ params }) => text(params.prefix));

    expect((await call(routes, 'GET', '/api/tokens/mine')).body).toBe('mine');
    expect((await call(routes, 'GET', '/api/tokens/wk_abc')).body).toBe('wk_abc');
  });

  it('lets one pattern answer several methods', async () => {
    const routes = router().on(['GET', 'POST'], '/auth/:provider/callback', ({ params }) => text(params.provider));

    expect((await call(routes, 'GET', '/auth/apple/callback')).status).toBe(200);
    expect((await call(routes, 'POST', '/auth/apple/callback')).status).toBe(200);
    expect((await call(routes, 'PUT', '/auth/apple/callback')).status).toBe(405);
  });

  it('serves HEAD from the GET route', async () => {
    const routes = router()
      .get('/api/health', () => text('ok'))
      .post('/api/tokens', () => text('created', 201));

    expect((await call(routes, 'HEAD', '/api/health')).status).toBe(200);
    // A path with no GET is still 405, not a HEAD that answers from nowhere.
    expect((await call(routes, 'HEAD', '/api/tokens')).status).toBe(405);
  });

  it('mounts a group of routes declared elsewhere', async () => {
    const tokens = (app: Router<Context>) => {
      app.get('/api/tokens', () => text('tokens'));
    };
    const routes = router().get('/api/health', () => text('ok')).mount(tokens);

    expect((await call(routes, 'GET', '/api/health')).body).toBe('ok');
    expect((await call(routes, 'GET', '/api/tokens')).body).toBe('tokens');
  });

  it('passes the rest of the context through untouched', async () => {
    const routes = router().get('/x', ({ seen }) => text(String(Array.isArray(seen))));

    expect((await call(routes, 'GET', '/x')).body).toBe('true');
  });
});
