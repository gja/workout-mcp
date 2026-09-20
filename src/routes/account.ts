// The athlete's account: identity, API tokens, and the MCP clients they have let in.

import * as auth from '../auth';
import * as db from '../db';
import type { AuthedRoute, Context } from '../http';
import { error, json, withUser } from '../http';
import type { Router } from '../router';

// The window is UTC, so a client computing it from local midnight would disagree at the edges.
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

/** Grants name the row they were approved under, which may since have been linked. */
const listConnections: AuthedRoute = async ({ env, user }) => {
  const listings = await Promise.all(
    (await auth.accountIds(env, user.id)).map((id) => env.OAUTH_PROVIDER.listUserGrants(id)),
  );
  const items = listings.flatMap((listing) => listing.items);
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
  // Against each row this account reaches: the grant is the athlete's either way, and the
  // provider takes the one owner it was stored under.
  for (const id of await auth.accountIds(env, user.id)) {
    await env.OAUTH_PROVIDER.revokeGrant(params.id, id);
  }
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
