// The Worker entry point: the OAuth provider wraps the app and claims /mcp.
// See docs/architecture.md for the request path, docs/mcp.md for the two credentials.

import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { app } from './app';
import * as auth from './auth';
import * as db from './db';
import * as drive from './drive';
import * as identity from './identity';
import type { Env } from './db';
import { handleMcp } from './mcp';
import * as platforms from './platforms';
import { APP_TOKEN_SCOPE, SCOPE } from './routes/oauth';
import { ToolError } from './tools';
import { WorkoutError } from './workout';

type AuthProps = { userId: string; email: string | null; scope?: string[] };

/** Spelled as `wrangler.jsonc` spells them. The third is the hourly completion pass. */
const NIGHTLY = '0 3 * * *';
const DRIVE = '40 * * * *';

/**
 * A grant, traded once for the credential the REST API takes. An OAuth access token
 * reaches `/mcp` and would 401 against `/api/`, so a native app fresh off a browser round
 * trip holds the wrong kind — this route hands back a `wk_` token instead, revocable on
 * the dashboard like any other.
 *
 * Behind its own scope, because the token outlives the grant: disconnecting the app would
 * not take it back. A grant carrying only `workouts` is refused. See docs/auth.md.
 */
const appTokenHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'POST an app token request' }, { status: 405 });

    const props = (ctx as ExecutionContext & { props?: AuthProps }).props;
    if (!props?.userId) return Response.json({ error: 'no authenticated user' }, { status: 401 });
    if (!props.scope?.includes(APP_TOKEN_SCOPE)) {
      return Response.json({ error: `this grant did not ask for the ${APP_TOKEN_SCOPE} scope` }, { status: 403 });
    }

    // The grant names a row rather than an athlete, and that row may have been deleted or
    // linked since it was approved. Neither is an account to mint a token against.
    const user = await auth.findAccount(env, props.userId);
    if (!user) return Response.json({ error: 'that account is no longer signed in' }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
    const issued = await auth.issueToken(env, user.id, name || 'A native app');

    return Response.json(issued, { headers: { 'Access-Control-Allow-Origin': '*' } });
  },
} satisfies ExportedHandler<Env>;

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'MCP requires POST' }, { status: 405 });

    const props = (ctx as ExecutionContext & { props?: AuthProps }).props;
    if (!props?.userId) return Response.json({ error: 'no authenticated user' }, { status: 401 });

    // Read rather than taken from the grant: the row it names may since have been deleted
    // or linked, and a client holding one connects again. See docs/auth.md.
    const user = await auth.findAccount(env, props.userId);
    if (!user) return Response.json({ error: 'that account is no longer signed in' }, { status: 401 });

    const response = await handleMcp(request, env, user);
    response.headers.set('Access-Control-Allow-Origin', '*');
    return response;
  },
} satisfies ExportedHandler<Env>;

const provider = new OAuthProvider<Env>({
  apiHandlers: { '/mcp': mcpHandler, '/api/app-token': appTokenHandler },
  defaultHandler: app,

  // The authorize endpoint is ours: only we know how to sign someone in.
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  authorizeEndpoint: '/oauth/authorize',

  scopesSupported: [SCOPE, APP_TOKEN_SCOPE],

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
        console.error('copying recorded sessions to Google Drive failed', err);
        return 0;
      });
      console.log(`drive pass copied ${copied} recorded sessions`);
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

    const links = await platforms.pruneOrphanedLinks(env);
    const credentials = await auth.pruneExpired(env);
    const abandoned = await identity.pruneLoginStates(env);
    const purged = await provider.purgeExpiredData(env);
    console.log(
      `nightly sweep marked ${completed} workouts done, and removed ${links} stale platform links, ` +
        `${credentials} expired sessions, ${abandoned} abandoned sign-ins and ` +
        `${purged.grantsPurged ?? 0} stale grants`,
    );
  },
} satisfies ExportedHandler<Env>;

export { ToolError, WorkoutError };
