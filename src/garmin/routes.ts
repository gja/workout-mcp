/**
 * The HTTP surface of the Garmin integration, as route handlers.
 *
 * Two halves, because they answer to two different sorts of caller:
 *
 *   - `/garmin/connect` and `/garmin/callback` are browser routes. The athlete
 *     is walked out to Garmin and back, so a failure has to land them on the
 *     dashboard with something to read, never on a JSON error document.
 *   - `/api/garmin/*` is the ordinary API, reached by the dashboard's fetches
 *     and by an MCP client's bearer token. It is deliberately about the
 *     *connection* — status, settings, disconnect — and not about syncing:
 *     syncing is provider-neutral and lives at `/api/sync`, so one action
 *     covers every platform the athlete has linked.
 *
 * The group declares its own paths at the bottom, the way every module under
 * `src/routes/` does, and `app.ts` mounts it. The dependency runs one way:
 * `app.ts` knows about Garmin's routes, and Garmin's routes know nothing about
 * `app.ts` — only the shared context in `src/http.ts`.
 */

import type { Env } from '../db';
import type { AuthedRoute, Context } from '../http';
import { error, json, withUser, withUserOrSignIn } from '../http';
import type { Router } from '../router';
import { GarminAuthError, authorizationUrl, deregister, exchangeCode, fetchGarminUserId, isConfigured, randomVerifier } from './oauth';
import * as store from './store';
import { status } from './sync';

/** Same-origin paths only, so the connect flow cannot become an open redirect. */
function safeReturnTo(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  return value.slice(0, 512);
}

/**
 * Back to the dashboard with a message for it to show.
 *
 * The dashboard already reads `?error=` after a failed sign-in; a separate
 * parameter keeps a Garmin problem from being reported as a sign-in one.
 */
const backToDashboard = (origin: string, path: string, params: Record<string, string> = {}): Response => {
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return Response.redirect(url.toString(), 302);
};

const declined = (origin: string, message: string): Response =>
  backToDashboard(origin, '/', { garmin_error: message });

// ---------------------------------------------------------------------------
// The browser flow
// ---------------------------------------------------------------------------

/**
 * `GET /garmin/connect` — out to Garmin's consent screen.
 *
 * The athlete is already signed in here, so the account the connection lands
 * on is never in doubt.
 */
export const startGarminConnect: AuthedRoute = async ({ url, env, user }) => {
  if (!isConfigured(env)) return declined(url.origin, 'Garmin sync is not configured on this server');

  // The state is the only thing standing between this flow and someone else's
  // callback being finished against this account, so it is a server-side
  // random value that never leaves the athlete's browser — the same reasoning
  // as `login_states` in `identity.ts`.
  const state = randomVerifier();
  const verifier = randomVerifier();
  await store.startConnect(env, user.id, state, verifier, safeReturnTo(url.searchParams.get('return_to')));

  return Response.redirect(await authorizationUrl(env, url.origin, state, verifier), 302);
};

/** `GET /garmin/callback` — back from Garmin, with a code to exchange. */
export const finishGarminConnect: AuthedRoute = async ({ url, env, user }) => {
  if (url.searchParams.get('error')) return declined(url.origin, 'the Garmin connection was declined');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return declined(url.origin, 'that Garmin response was incomplete');

  let flow: Awaited<ReturnType<typeof store.takeConnectState>>;
  try {
    flow = await store.takeConnectState(env, state);
  } catch (failure) {
    return declined(
      url.origin,
      failure instanceof GarminAuthError ? failure.message : 'that Garmin connection could not be completed',
    );
  }

  // The flow names the athlete who started it. Landing it on whoever is signed
  // in now would attach a Garmin account to the wrong workouts if the browser
  // had switched accounts in between.
  if (flow.userId !== user.id) {
    return declined(url.origin, 'that Garmin connection was started by a different account — please try again');
  }

  try {
    const tokens = await exchangeCode(env, url.origin, code, flow.verifier);
    // Best effort, and stored as null if it fails: knowing Garmin's id for the
    // athlete is a nicety, and not knowing it is no reason to refuse a
    // connection that otherwise worked.
    const garminUserId = await fetchGarminUserId(tokens.accessToken);
    await store.saveTokens(env, user.id, tokens, garminUserId);
  } catch (failure) {
    return declined(
      url.origin,
      failure instanceof GarminAuthError ? failure.message : 'that Garmin connection could not be completed',
    );
  }

  return backToDashboard(url.origin, flow.returnTo ?? '/', { garmin_connected: '1' });
};

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

/** `GET /api/garmin/status`. */
export const garminStatus: AuthedRoute = async ({ env, user }) => json(await status(env, user.id));

/** `PUT /api/garmin/settings` — `{auto_sync}`. */
export const setGarminSettings: AuthedRoute = async ({ request, env, user }) => {
  const body = (await request.json().catch(() => ({}))) as { auto_sync?: unknown };
  if (typeof body.auto_sync !== 'boolean') return error('auto_sync must be true or false', 400);
  if (!(await store.getConnection(env, user.id))) return error('no Garmin account is connected', 404);
  await store.setAutoSync(env, user.id, body.auto_sync);
  return json(await status(env, user.id));
};

/** `POST /api/garmin/disconnect`. */
export const disconnectGarmin: AuthedRoute = async ({ env, user }) => json(await disconnectAccount(env, user.id));

/**
 * Forget the athlete's Garmin account.
 *
 * Garmin is told first, so the app stops being listed as connected on their
 * side too — but our row goes either way. The athlete asked to disconnect, and
 * refusing because Garmin was unreachable would leave them holding credentials
 * they have already said they do not want.
 *
 * What stays behind on purpose is the workouts already on their calendar.
 * Disconnecting is "stop sending", not "undo the training plan".
 */
export async function disconnectAccount(
  env: Env,
  userId: string,
): Promise<{ disconnected: boolean; deregistered: boolean; note: string }> {
  const connection = await store.getConnection(env, userId);
  const deregistered = connection ? await deregister(connection.accessToken) : false;
  const disconnected = await store.disconnect(env, userId);

  return {
    disconnected,
    deregistered,
    note: disconnected
      ? 'Workouts already on the Garmin calendar were left there; nothing new will be pushed.'
      : 'No Garmin account was connected.',
  };
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const routes = (app: Router<Context>): void => {
  app
    // The browser journeys, so a caller without a session is sent to sign in
    // rather than handed a 401 it cannot act on.
    .get('/garmin/connect', withUserOrSignIn(startGarminConnect))
    .get('/garmin/callback', withUserOrSignIn(finishGarminConnect))

    .get('/api/garmin/status', withUser(garminStatus))
    .put('/api/garmin/settings', withUser(setGarminSettings))
    .post('/api/garmin/disconnect', withUser(disconnectGarmin));
};
