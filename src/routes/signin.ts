// The two legs of the redirect dance, and the cookie that falls out of it.

import * as auth from '../auth';
import * as identity from '../identity';
import type { AuthedRoute, Context, Route } from '../http';
import { error, json, withUser } from '../http';
import * as platforms from '../platforms';
import type { Router } from '../router';

/** Google's callback arrives in the query string, Apple's as a form body. */
async function callbackParams(request: Request, url: URL): Promise<URLSearchParams> {
  if (request.method !== 'POST') return url.searchParams;
  const form = await request.formData();
  const params = new URLSearchParams();
  for (const [key, value] of form) if (typeof value === 'string') params.set(key, value);
  return params;
}

/** `Response.redirect` is immutable, so adding a cookie means rebuilding it. */
function withCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', cookie);
  return new Response(response.body, { status: response.status, headers });
}

/** A message for the dashboard to show after a failed sign-in. */
const backToDashboard = (origin: string, message?: string): Response =>
  Response.redirect(message ? `${origin}/?error=${encodeURIComponent(message)}` : `${origin}/`, 302);

/** Which buttons the dashboard should offer. */
const listProviders: Route = ({ env, url }) => json({ providers: identity.configuredProviders(env, url.origin) });

const startLogin: Route<'/auth/:provider/start'> = async ({ url, env, params }) => {
  if (!identity.isProviderName(params.provider)) return error(`unknown sign-in provider "${params.provider}"`, 404);
  try {
    const returnTo = url.searchParams.get('return_to');
    const { url: authorizationUrl, state } = await identity.startLogin(env, params.provider, url.origin, returnTo);
    // The state also goes to the browser, so the callback can prove whose sign-in it finishes.
    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizationUrl,
        'Set-Cookie': identity.loginCookie(state, url.protocol === 'https:'),
      },
    });
  } catch (err) {
    if (err instanceof identity.LoginError) return error(err.message, 400);
    throw err;
  }
};

const finishLogin: Route<'/auth/:provider/callback'> = async ({ request, url, env, params }) => {
  if (!identity.isProviderName(params.provider)) return error(`unknown sign-in provider "${params.provider}"`, 404);
  const secure = url.protocol === 'https:';

  // Google comes back as a redirect; Apple posts a form, cross-site.
  const callback = await callbackParams(request, url);
  const started = auth.readCookie(request, identity.LOGIN_COOKIE);
  // Spent either way, so a failed attempt cannot be retried against it.
  const clearLoginCookie = identity.loginCookie(null, secure);

  let who: identity.Identity;
  try {
    who = await identity.completeLogin(env, params.provider, callback, url.origin, started);
  } catch (err) {
    if (err instanceof identity.LoginError) {
      return withCookie(backToDashboard(url.origin, err.message), clearLoginCookie);
    }
    throw err;
  }

  const user = await auth.upsertUser(env, who);

  // Signing in with intervals.icu hands us a platform credential as a side effect, and
  // asking for it twice would be theatre. Nothing is pushed here: the account this
  // sign-in lands in is keyed on that athlete, so on a first sign-in it is empty, and
  // on a later one its calendar is already in step. See docs/integrations.md.
  if (who.grant && platforms.credentialsConfigured(env)) {
    await platforms
      .connect(env, user, 'intervals', who.grant.accessToken, who.grant.athlete)
      // Never fails the sign-in: they are in, and the dashboard offers Connect.
      .catch((err: unknown) => console.error('storing the intervals.icu token from a sign-in failed', err));
  }

  const session = await auth.createSession(env, user.id);
  // 303, so the browser follows Apple's POST callback with a GET.
  const response = new Response(null, {
    status: 303,
    headers: {
      Location: `${url.origin}${who.returnTo ?? '/'}`,
      'Set-Cookie': auth.sessionCookie(session, secure),
    },
  });
  response.headers.append('Set-Cookie', clearLoginCookie);
  return response;
};

// --- Connecting intervals.icu, whoever you signed in as ----------------------

/**
 * Start the same OAuth round, but for a connection rather than a session.
 *
 * Under `/auth` so the login cookie's `Path=/auth` still reaches the callback,
 * and behind `withUser` because the token it returns with is hung on that athlete.
 */
const startConnect: AuthedRoute = async ({ url, env, user }) => {
  try {
    const { url: authorizationUrl, state } = await identity.startConnect(
      env,
      url.origin,
      user.id,
      url.searchParams.get('return_to'),
    );
    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizationUrl,
        'Set-Cookie': identity.loginCookie(state, url.protocol === 'https:'),
      },
    });
  } catch (err) {
    if (err instanceof identity.LoginError) return error(err.message, 400);
    throw err;
  }
};

/** The connect callback. No session is minted here: the athlete already had one. */
const finishConnect: AuthedRoute = async ({ request, url, env, user }) => {
  const secure = url.protocol === 'https:';
  const clearLoginCookie = identity.loginCookie(null, secure);
  const started = auth.readCookie(request, identity.LOGIN_COOKIE);

  let connected;
  try {
    connected = await identity.completeConnect(env, url.searchParams, url.origin, started, user.id);
  } catch (err) {
    if (err instanceof identity.LoginError) {
      return withCookie(backToDashboard(url.origin, err.message), clearLoginCookie);
    }
    throw err;
  }

  try {
    await platforms.connect(env, user, 'intervals', connected.grant.accessToken, connected.grant.athlete);
  } catch (err) {
    const why =
      err instanceof platforms.CredentialsUnavailable ? err.message : 'that connection could not be stored';
    return withCookie(backToDashboard(url.origin, why), clearLoginCookie);
  }

  // Straight away, not on the next hourly pass: a calendar that fills in an hour later looks broken.
  await platforms.syncNow(env, user, 'intervals');

  return withCookie(
    Response.redirect(`${url.origin}${connected.returnTo ?? '/'}`, 302),
    clearLoginCookie,
  );
};

const logout: Route = async ({ request, url, env }) => {
  await auth.endSession(env, request);
  return json({ ok: true }, 200, { 'Set-Cookie': auth.sessionCookie(null, url.protocol === 'https:') });
};

export const routes = (app: Router<Context>): void => {
  app
    .get('/auth/providers', listProviders)

    // Declared before the `:provider` patterns, so a later reshuffle cannot have
    // these start resolving to a sign-in — they must never mint a session.
    .get('/auth/intervals/connect', withUser(startConnect))
    .get(identity.CONNECT_CALLBACK, withUser(finishConnect))

    .get('/auth/:provider/start', startLogin)
    .on(['GET', 'POST'], '/auth/:provider/callback', finishLogin)
    .post('/api/auth/logout', logout);
};
