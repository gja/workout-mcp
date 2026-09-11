// The two legs of the redirect dance, and the cookie that falls out of it.

import * as auth from '../auth';
import * as identity from '../identity';
import type { Context, Route } from '../http';
import { error, json } from '../http';
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

  // An unverified address is a claim, not a fact, so the allowlist is asked as if there were none.
  if (!auth.isAllowed(env, who.emailVerified ? who.email : null)) {
    return withCookie(
      backToDashboard(url.origin, 'that account is not allowed to sign in here'),
      clearLoginCookie,
    );
  }

  const user = await auth.upsertUser(env, who);
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

const logout: Route = async ({ request, url, env }) => {
  await auth.endSession(env, request);
  return json({ ok: true }, 200, { 'Set-Cookie': auth.sessionCookie(null, url.protocol === 'https:') });
};

export const routes = (app: Router<Context>): void => {
  app
    .get('/auth/providers', listProviders)
    .get('/auth/:provider/start', startLogin)
    .on(['GET', 'POST'], '/auth/:provider/callback', finishLogin)
    .post('/api/auth/logout', logout);
};
