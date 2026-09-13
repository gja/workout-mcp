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

const saveOne = async ({ request, env, user, params }: Named) => {
  const kind = namedKind(params.kind);
  if (kind instanceof Response) return kind;
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
