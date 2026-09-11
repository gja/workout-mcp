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
import { app } from './app';
import * as auth from './auth';
import * as db from './db';
import * as identity from './identity';
import type { Env, User } from './db';
import { handleMcp } from './mcp';
import * as platforms from './platforms';
import { SCOPE } from './routes/oauth';
import { ToolError } from './tools';
import { WorkoutError } from './workout';

/** What `completeAuthorization` stores on the grant, and hands back here. */
type AuthProps = { userId: string; email: string | null };

/** The sweep's cron, as `wrangler.jsonc` spells it. The other one is hourly. */
const NIGHTLY = '0 3 * * *';

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

  /**
   * Two schedules, told apart by which cron fired.
   *
   * Hourly: read completions back off the connected platforms. intervals.icu
   * delivers webhooks only to OAuth applications it has approved, and this
   * integration is a key the athlete pastes in, so there is no callback to
   * register — a session recorded there becomes a workout marked done here
   * within the hour instead.
   *
   * Nightly (`NIGHTLY`): the credential housekeeping — expired sessions,
   * abandoned sign-ins, stale OAuth grants — plus a retry of any platform
   * connection stuck on an error, since nothing else picks those up.
   *
   * Workouts are deliberately not swept. The window and the per-user cap are
   * enforced on the way in and on every read, so an older session stops being
   * visible without anything having to delete it; see `src/db.ts`.
   */
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    // Guarded, and first: reading completions means talking to somebody
    // else's server, and none of the housekeeping below should be skipped
    // because that went wrong.
    const completed = await platforms.pullEveryCompletion(env).catch((err: unknown) => {
      console.error('reading completions back failed', err);
      return 0;
    });

    if (event.cron !== NIGHTLY) {
      console.log(`hourly pass marked ${completed} workouts done`);
      return;
    }

    const retried = await platforms.retryFailedConnections(env).catch((err: unknown) => {
      console.error('retrying stuck platform connections failed', err);
      return 0;
    });
    const links = await platforms.pruneOrphanedLinks(env);
    const credentials = await auth.pruneExpired(env);
    const abandoned = await identity.pruneLoginStates(env);
    const purged = await provider.purgeExpiredData(env);
    console.log(
      `nightly sweep marked ${completed} workouts done, brought ${retried} platform connections back, ` +
        `and removed ${links} stale platform links, ${credentials} expired sessions, ` +
        `${abandoned} abandoned sign-ins and ${purged.grantsPurged ?? 0} stale grants`,
    );
  },
} satisfies ExportedHandler<Env>;

export { ToolError, WorkoutError };
