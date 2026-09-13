// The athlete's context documents, read and edited from the dashboard.

import * as context from '../context';
import type { AuthedContext, AuthedRoute, Context } from '../http';
import { CORS_HEADERS, error, json, withUser } from '../http';
import type { Router } from '../router';

const KIND = '/api/context/:kind([a-z-]+)';

type Named = AuthedContext & { params: { kind: string } };

/** The kind the path named, or a 404 to return instead. */
const namedKind = (value: string): context.ContextKind | Response =>
  context.isContextKind(value) ? value : error(`unknown context "${value}"`, 404);

const readEvery: AuthedRoute = async ({ env, user }) =>
  json({ contexts: await context.readEveryContext(env, user.id) });

const readOne = async ({ env, user, params }: Named) => {
  const kind = namedKind(params.kind);
  return kind instanceof Response ? kind : json(await context.readContext(env, user.id, kind));
};

/**
 * A bound on what is parsed, not on the document: JSON escaping can multiply a
 * document several times over, so this is far above the real limit and only
 * there to keep an absurd body from being materialised before it is refused.
 */
const MAX_BODY_BYTES = context.MAX_CONTEXT_BYTES * 8;

const saveOne = async ({ request, env, user, params }: Named) => {
  const kind = namedKind(params.kind);
  if (kind instanceof Response) return kind;

  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return error(`that body is ${declared} bytes; a context document may be at most ${context.MAX_CONTEXT_BYTES}`, 413);
  }

  const body = (await request.json()) as { markdown?: unknown };
  return json(await context.saveContext(env, user.id, kind, body?.markdown));
};

const clearOne = async ({ env, user, params }: Named) => {
  const kind = namedKind(params.kind);
  return kind instanceof Response ? kind : json(await context.clearContext(env, user.id, kind));
};

/** Every document as one ZIP, so the athlete's own words are never only here. */
const backup: AuthedRoute = async ({ env, user }) =>
  new Response(await context.backupArchive(env, user.id), {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${context.BACKUP_FILENAME}"`,
      'Cache-Control': 'no-store',
    },
  });

export const routes = (app: Router<Context>): void => {
  app
    .get('/api/context', withUser(readEvery))
    .get('/api/context.zip', withUser(backup))
    .get(KIND, withUser(readOne))
    .put(KIND, withUser(saveOne))
    .delete(KIND, withUser(clearOne));
};
