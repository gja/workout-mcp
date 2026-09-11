// The Worker entry point: the OAuth provider wraps the app and claims /mcp.
// See docs/architecture.md for the request path, docs/mcp.md for the two credentials.

import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { app } from './app';
import * as auth from './auth';
import * as db from './db';
import * as drive from './drive';
import * as identity from './identity';
import type { Env, User } from './db';
import { handleMcp } from './mcp';
import * as platforms from './platforms';
import { SCOPE } from './routes/oauth';
import { ToolError } from './tools';
import { WorkoutError } from './workout';

/** What `completeAuthorization` stores on the grant, and hands back here. */
type AuthProps = { userId: string; email: string | null };

/** Spelled as `wrangler.jsonc` spells them. The third is the hourly completion pass. */
const NIGHTLY = '0 3 * * *';
const DRIVE = '40 * * * *';

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

  // The authorize endpoint is ours: only we know how to sign someone in.
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  authorizeEndpoint: '/oauth/authorize',

  scopesSupported: [SCOPE],

  // `resourceMetadata` is left unset on purpose, so the provider derives it per request.

  /** Our own `wk_` tokens, through the same door. Only called for tokens it did not issue. */
  async resolveExternalToken({ token, env }) {
    if (!auth.isApiToken(token)) return null;
    const user = await auth.findTokenOwner(env, token);
    return user ? { props: { userId: user.id, email: user.email } satisfies AuthProps } : null;
  },
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => provider.fetch(request, env, ctx),

  /** Three schedules, told apart by which cron fired. See "Scheduled work" in docs/deployment.md. */
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    // Its own invocation, so it gets its own subrequest allowance rather than
    // whatever the completion sweep below left of a 50-call budget.
    if (event.cron === DRIVE) {
      const copied = await drive.copyForEveryone(env).catch((err: unknown) => {
        console.error('copying races to Google Drive failed', err);
        return 0;
      });
      console.log(`drive pass copied ${copied} races`);
      return;
    }

    // Guarded: this talks to someone else's server, and the housekeeping below
    // must not be skipped because that went wrong.
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
