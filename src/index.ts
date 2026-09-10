/**
 * The Worker entry point.
 *
 * `@cloudflare/workers-oauth-provider` wraps the app: it owns the OAuth
 * metadata documents, the token endpoint and client registration, validates
 * the bearer token on `/mcp`, and passes everything else to `app`.
 *
 * Two kinds of credential reach `/mcp`:
 *
 *   - an OAuth access token the provider issued, which it validates itself;
 *   - one of our own `wk_` API tokens, resolved by `resolveExternalToken`,
 *     for MCP clients that only take a static header.
 *
 * Both arrive at the handler below as the same `ctx.props`.
 */

import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { SCOPE, app } from './app';
import * as auth from './auth';
import * as db from './db';
import * as identity from './identity';
import type { Env, User } from './db';
import { handleMcp } from './mcp';
import { ToolError } from './tools';
import { WorkoutError } from './workout';

/** What `completeAuthorization` stores on the grant, and hands back here. */
type AuthProps = { userId: string; email: string | null };

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'MCP requires POST' }, { status: 405 });

    const props = (ctx as ExecutionContext & { props?: AuthProps }).props;
    if (!props?.userId) return Response.json({ error: 'no authenticated user' }, { status: 401 });

    const user: User = { id: props.userId, email: props.email };
    const response = await handleMcp(request, env, user);
    response.headers.set('Access-Control-Allow-Origin', '*');
    return response;
  },
} satisfies ExportedHandler<Env>;

const provider = new OAuthProvider<Env>({
  apiRoute: '/mcp',
  apiHandler: mcpHandler,
  defaultHandler: app,

  // The provider implements these two; the authorize endpoint is ours,
  // because only we know how to sign someone in.
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  authorizeEndpoint: '/oauth/authorize',

  scopesSupported: [SCOPE],

  // `resourceMetadata` is deliberately left unset: the provider then derives
  // the resource and issuer from the request, so the same build works on
  // localhost and on your domain with nothing to configure.

  /**
   * Let our own API tokens through the same door as OAuth tokens. Called
   * only when the token is not one the provider issued.
   */
  async resolveExternalToken({ token, env }) {
    if (!auth.isApiToken(token)) return null;
    const user = await auth.findTokenOwner(env, token);
    return user ? { props: { userId: user.id, email: user.email } satisfies AuthProps } : null;
  },
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => provider.fetch(request, env, ctx),

  /** Nightly sweep: workout retention, expired logins, and stale OAuth data. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const workouts = await db.pruneAll(env);
    const credentials = await auth.pruneExpired(env);
    const abandoned = await identity.pruneLoginStates(env);
    const purged = await provider.purgeExpiredData(env);
    console.log(
      `nightly sweep removed ${workouts} workouts, ${credentials} expired sessions, ` +
        `${abandoned} abandoned sign-ins, and ${purged.grantsPurged ?? 0} stale grants`,
    );
  },
} satisfies ExportedHandler<Env>;

export { ToolError, WorkoutError };
