// The consent page and the grant it produces — the one OAuth endpoint that is ours.

import { AuthorizationError } from '@cloudflare/workers-oauth-provider';
import type { AuthedRoute, Context, Route } from '../http';
import { error, json, withUser } from '../http';
import type { Router } from '../router';

export const SCOPE = 'workouts';

/** A bad client_id or redirect_uri is reported, never redirected to. */
const showConsent: Route = async ({ request, url, env }) => {
  try {
    await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    if (!(err instanceof AuthorizationError)) throw err;
    if (!err.redirectUri) return json({ error: err.code, error_description: err.description }, 400);

    const redirect = new URL(err.redirectUri);
    redirect.searchParams.set('error', err.code);
    redirect.searchParams.set('error_description', err.description);
    if (err.state) redirect.searchParams.set('state', err.state);
    if (err.issuer) redirect.searchParams.set('iss', err.issuer);
    return Response.redirect(redirect.toString(), 302);
  }

  return env.ASSETS.fetch(new Request(new URL('/authorize.html', url.origin), { headers: request.headers }));
};

/** The athlete has signed in and pressed Allow. */
const grantConsent: AuthedRoute = async ({ request, env, user }) => {
  let authRequest;
  try {
    // Re-parsed, so the grant is built from parameters just re-validated.
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    if (!(err instanceof AuthorizationError)) throw err;
    return json({ error: err.code, error_description: err.description }, 400);
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: user.id,
    metadata: { clientName: client?.clientName ?? 'An MCP client' },
    scope: authRequest.scope.length > 0 ? authRequest.scope : [SCOPE],
    props: { userId: user.id, email: user.email },
  });

  return json({ redirect: redirectTo });
};

/** So the consent page can say who is asking. */
const describeClient: Route = async ({ url, env }) => {
  const client = await env.OAUTH_PROVIDER.lookupClient(url.searchParams.get('client_id') ?? '');
  return client
    ? json({ client_id: client.clientId, client_name: client.clientName ?? 'An MCP client' })
    : error('unknown client_id', 404);
};

export const routes = (app: Router<Context>): void => {
  app
    .get('/oauth/authorize', showConsent)
    .post('/oauth/authorize', withUser(grantConsent))
    .get('/oauth/client', describeClient);
};
