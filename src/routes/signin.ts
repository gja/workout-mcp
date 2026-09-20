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

/**
 * Which buttons to offer. `native` is the app's business alone: a provider listed there has
 * a sign-in that needs no browser, which on the dashboard is nothing at all.
 */
const listProviders: Route = ({ env, url }) =>
  json({
    providers: identity.configuredProviders(env, url.origin),
    native: identity.appleAppConfigured(env) ? ['apple'] : [],
  });

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

  // Signing in with intervals.icu hands us a platform credential as a side effect, so
  // asking for it twice would be theatre. Nothing is pushed: the account is keyed on that
  // athlete, so it is either empty or already in step.
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

/**
 * The native Sign in with Apple, which has no browser and so no session: the app posts the
 * authorization code its own sheet produced, and gets the `wk_` token every other REST
 * caller holds. Unauthenticated because the code *is* the credential — Apple issues it for
 * this team alone, it is single use, and it is spent here. See docs/auth.md.
 */
const appleAppSession: Route = async ({ request, env }) => {
  if (!identity.appleAppConfigured(env)) return error('the app sign-in is not configured on this server', 404);

  const body = (await request.json().catch(() => ({}))) as { code?: unknown; name?: unknown };
  if (typeof body.code !== 'string' || !body.code) return error('an Apple authorization code is required', 400);

  let who: identity.Identity;
  try {
    who = await identity.completeAppleAppLogin(env, body.code);
  } catch (err) {
    if (err instanceof identity.LoginError) return error(err.message, 401);
    throw err;
  }

  // The same door the browser flow uses, so a native sign-in and a web one land on one
  // account: Apple scopes the subject to the team, not to the client that asked.
  const user = await auth.upsertUser(env, who);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
  return json(await auth.issueToken(env, user.id, name || 'A native app'));
};

// --- Connecting intervals.icu, whoever you signed in as ----------------------

/**
 * The same OAuth round for a connection rather than a session. Under `/auth` so the login
 * cookie's `Path=/auth` reaches the callback, and behind `withUser` because the token is
 * hung on that athlete.
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

    .post('/api/apple-session', appleAppSession)

    .get('/auth/:provider/start', startLogin)
    .on(['GET', 'POST'], '/auth/:provider/callback', finishLogin)
    .post('/api/auth/logout', logout);
};
