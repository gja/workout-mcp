/**
 * The athlete's own account: who they are, the API tokens they have minted,
 * and the MCP clients they have let in.
 *
 * Tokens are ours, in D1. Connections are OAuth grants, which the provider
 * keeps in KV — revoking one invalidates its access and refresh tokens
 * together.
 */

import * as auth from '../auth';
import * as db from '../db';
import type { AuthedRoute, Context } from '../http';
import { error, json, withUser } from '../http';
import type { Router } from '../router';

// The window comes from the server because it is computed in UTC: a client
// deriving it from its own local midnight would disagree at the edges and
// drop a workout the server legitimately returned.
const whoAmI: AuthedRoute = ({ user }) => json({ ...user, window: db.retentionWindow() });

const listTokens: AuthedRoute = async ({ env, user }) => json({ tokens: await auth.listTokens(env, user.id) });

const createToken: AuthedRoute = async ({ request, env, user }) => {
  const body = (await request.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : null;
  const issued = await auth.issueToken(env, user.id, name || 'API token');
  // The only time the full token is ever returned.
  return json({ ...issued, note: 'Copy this now — it is stored only as a hash.' }, 201);
};

const revokeToken: AuthedRoute<'/api/tokens/:prefix'> = async ({ env, user, params }) =>
  (await auth.revokeToken(env, user.id, params.prefix)) ? json({ revoked: true }) : error('no such token', 404);

const listConnections: AuthedRoute = async ({ env, user }) => {
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

const revokeConnection: AuthedRoute<'/api/connections/:id'> = async ({ env, user, params }) => {
  await env.OAUTH_PROVIDER.revokeGrant(params.id, user.id);
  return json({ revoked: true });
};

export const routes = (app: Router<Context>): void => {
  app
    .get('/api/me', withUser(whoAmI))

    .get('/api/tokens', withUser(listTokens))
    .post('/api/tokens', withUser(createToken))
    .delete('/api/tokens/:prefix', withUser(revokeToken))

    .get('/api/connections', withUser(listConnections))
    .delete('/api/connections/:id', withUser(revokeConnection));
};
