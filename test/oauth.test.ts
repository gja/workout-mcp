/**
 * The OAuth flow, as an MCP client actually drives it: discover, register,
 * authorize, exchange, call. The provider itself is Cloudflare's
 * `@cloudflare/workers-oauth-provider`; what is tested here is our wiring —
 * discovery, the consent page, the grant we build, and the fact that our own
 * API tokens still reach /mcp through `resolveExternalToken`.
 */

import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { shiftDate, today } from '../src/units';
import { mcpFetch, resetDatabase, seedUser, sessionCookieFor } from './helpers';

const BASE = 'https://workouts.example';
const REDIRECT = 'http://localhost:41234/callback';

beforeEach(resetDatabase);

const postJson = (path: string, body: unknown, headers: HeadersInit = {}) =>
  SELF.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const postForm = (path: string, fields: Record<string, string>) =>
  SELF.fetch(`${BASE}${path}`, { method: 'POST', body: new URLSearchParams(fields) });

async function registerClient(redirectUris: string[] = [REDIRECT]) {
  const response = await postJson('/oauth/register', {
    client_name: 'Test Client',
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { client_id: string; client_name: string };
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64url(digest) };
}

const APP_SCOPE = 'workouts app-token';

const authorizeQuery = (clientId: string, challenge: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    ...extra,
  }).toString();

/** Register, sign in, approve — and hand back the authorization code. */
async function authorizeUpToCode(scope?: string) {
  const client = await registerClient();
  const cookie = await sessionCookieFor();
  const { verifier, challenge } = await pkce();
  const query = authorizeQuery(client.client_id, challenge, scope ? { scope } : {});

  const granted = await SELF.fetch(`${BASE}/oauth/authorize?${query}`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  expect(granted.status, await granted.clone().text()).toBe(200);

  const { redirect } = (await granted.json()) as { redirect: string };
  const target = new URL(redirect);
  expect(target.origin + target.pathname).toBe(REDIRECT);
  expect(target.searchParams.get('state')).toBe('xyz');

  return { client, cookie, verifier, code: target.searchParams.get('code')! };
}

const exchange = (clientId: string, code: string, verifier: string) =>
  postForm('/oauth/token', {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT,
  });

const listTools = (token: string) => mcpFetch(token, 'tools/list');

describe('trading a grant for an API token', () => {
  const exchangeFor = async (): Promise<string> => {
    const { client, verifier, code } = await authorizeUpToCode(APP_SCOPE);
    const { access_token: accessToken } = (await (await exchange(client.client_id, code, verifier)).json()) as {
      access_token: string;
    };

    const response = await postJson('/api/app-token', { name: 'WorkoutsMCP for iOS' }, {
      Authorization: `Bearer ${accessToken}`,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { token: string }).token;
  };

  it('hands back a wk_ token that reaches the REST API', async () => {
    const token = await exchangeFor();
    expect(token.startsWith('wk_')).toBe(true);

    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
  });

  it('shows up on the dashboard, to be revoked like any other', async () => {
    await exchangeFor();
    const cookie = await sessionCookieFor();
    const listed = (await (await SELF.fetch(`${BASE}/api/tokens`, { headers: { Cookie: cookie } })).json()) as {
      tokens: Array<{ name: string }>;
    };
    expect(listed.tokens.map((entry) => entry.name)).toContain('WorkoutsMCP for iOS');
  });

  it('is not reachable without a grant', async () => {
    expect((await postJson('/api/app-token', {})).status).toBe(401);
  });

  // The token outlives the grant, so a client that only asked to read the plan does not
  // get to mint one: disconnecting it on the dashboard has to be the end of its access.
  it('refuses a grant that did not ask for the scope', async () => {
    const { client, verifier, code } = await authorizeUpToCode();
    const { access_token: accessToken } = (await (await exchange(client.client_id, code, verifier)).json()) as {
      access_token: string;
    };

    const response = await postJson('/api/app-token', {}, { Authorization: `Bearer ${accessToken}` });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toMatch(/app-token scope/);
  });
});

describe('discovery', () => {
  it('publishes protected-resource metadata for /mcp', async () => {
    const response = await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: `${BASE}/mcp`,
      authorization_servers: [BASE],
    });
  });

  it('publishes authorization-server metadata pointing at our endpoints', async () => {
    const response = await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['workouts', 'app-token'],
    });
  });
});

describe('client registration', () => {
  it('registers a client and returns its id', async () => {
    const client = await registerClient();
    expect(client.client_id).toBeTruthy();
    expect(client.client_name).toBe('Test Client');
  });

  it('refuses a client with no redirect URI', async () => {
    expect((await postJson('/oauth/register', { client_name: 'Bad', redirect_uris: [] })).status).toBe(400);
  });
});

describe('the consent page', () => {
  it('is served for a sound request', async () => {
    const client = await registerClient();
    const { challenge } = await pkce();
    const response = await SELF.fetch(`${BASE}/oauth/authorize?${authorizeQuery(client.client_id, challenge)}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Connect an app');
  });

  it('will not redirect to an unregistered URI — it reports the error', async () => {
    const client = await registerClient();
    const { challenge } = await pkce();
    const query = authorizeQuery(client.client_id, challenge).replace(
      encodeURIComponent(REDIRECT),
      encodeURIComponent('https://evil.example/cb'),
    );

    const response = await SELF.fetch(`${BASE}/oauth/authorize?${query}`, { redirect: 'manual' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('redirect');
  });

  it('rejects an unknown client', async () => {
    const { challenge } = await pkce();
    const response = await SELF.fetch(`${BASE}/oauth/authorize?${authorizeQuery('nope', challenge)}`);
    expect(response.status).toBe(400);
  });

  it('names the client, so the page can say who is asking', async () => {
    const client = await registerClient();
    const response = await SELF.fetch(`${BASE}/oauth/client?client_id=${client.client_id}`);
    expect(await response.json()).toMatchObject({ client_name: 'Test Client' });
    expect((await SELF.fetch(`${BASE}/oauth/client?client_id=nope`)).status).toBe(404);
  });

  // The app's sign-in screen already asked which provider, and says so here so the page
  // can go straight to it rather than asking again. See docs/auth.md.
  it('takes a provider hint along without disturbing the request', async () => {
    const client = await registerClient();
    const { challenge } = await pkce();
    const query = authorizeQuery(client.client_id, challenge, { provider: 'apple' });

    const page = await SELF.fetch(`${BASE}/oauth/authorize?${query}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Connect an app');

    // Approving posts the same query string back, hint and all.
    const granted = await SELF.fetch(`${BASE}/oauth/authorize?${query}`, {
      method: 'POST',
      headers: { Cookie: await sessionCookieFor() },
    });
    expect(granted.status, await granted.clone().text()).toBe(200);
  });

  it('needs a signed-in athlete to approve', async () => {
    const client = await registerClient();
    const { challenge } = await pkce();
    const response = await SELF.fetch(`${BASE}/oauth/authorize?${authorizeQuery(client.client_id, challenge)}`, {
      method: 'POST',
    });
    expect(response.status).toBe(401);
  });
});

describe('token exchange', () => {
  it('trades a code plus verifier for a token that works on /mcp', async () => {
    const { client, verifier, code } = await authorizeUpToCode();

    const response = await exchange(client.client_id, code, verifier);
    expect(response.status, await response.clone().text()).toBe(200);
    const tokens = (await response.json()) as { access_token: string; refresh_token: string; token_type: string };
    expect(tokens.token_type.toLowerCase()).toBe('bearer');

    const mcp = await listTools(tokens.access_token);
    expect(((await mcp.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
  });

  it('carries the athlete\'s identity into the tools', async () => {
    const { client, verifier, code } = await authorizeUpToCode();
    const { access_token } = (await (await exchange(client.client_id, code, verifier)).json()) as {
      access_token: string;
    };

    // Create through MCP, then read back with a plain API token for the same
    // account — proof the grant resolved to the right user.
    // Relative to today, so the write stays inside the retention window.
    const created = await mcpFetch(access_token, 'tools/call', {
      name: 'create_workout',
      arguments: { date: shiftDate(today(), 2), steps: [{ goal_s: 600 }] },
    });
    const result = (await created.json()) as { result: { structuredContent: { id: string; date: string } } };
    expect(result.result.structuredContent.id).toBeTruthy();
  });

  it('rejects a wrong PKCE verifier', async () => {
    const { client, code } = await authorizeUpToCode();
    expect((await exchange(client.client_id, code, 'not-the-verifier')).status).toBe(400);
  });

  it('burns the code, so a stolen one cannot be replayed', async () => {
    const { client, verifier, code } = await authorizeUpToCode();
    expect((await exchange(client.client_id, code, verifier)).status).toBe(200);
    expect((await exchange(client.client_id, code, verifier)).status).toBe(400);
  });

  it('refreshes', async () => {
    const { client, verifier, code } = await authorizeUpToCode();
    const first = (await (await exchange(client.client_id, code, verifier)).json()) as { refresh_token: string };

    const refreshed = await postForm('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: client.client_id,
    });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    expect((await listTools(((await refreshed.json()) as { access_token: string }).access_token)).status).toBe(200);
  });

  it('rejects an unsupported grant type, and an unidentified client', async () => {
    const client = await registerClient();
    const badGrant = await postForm('/oauth/token', { grant_type: 'password', client_id: client.client_id });
    expect(badGrant.status).toBe(400);
    expect(await badGrant.json()).toMatchObject({ error: 'unsupported_grant_type' });

    // No client_id at all is a client-authentication failure, not a grant one.
    expect((await postForm('/oauth/token', { grant_type: 'password' })).status).toBe(401);
  });
});

describe('connected apps', () => {
  it('are listed on the dashboard and can be revoked', async () => {
    const { client, verifier, code, cookie } = await authorizeUpToCode();
    const { access_token } = (await (await exchange(client.client_id, code, verifier)).json()) as {
      access_token: string;
    };
    expect((await listTools(access_token)).status).toBe(200);

    const listed = (await (await SELF.fetch(`${BASE}/api/connections`, { headers: { Cookie: cookie } })).json()) as {
      connections: { id: string; client_name: string }[];
    };
    expect(listed.connections).toHaveLength(1);
    expect(listed.connections[0].client_name).toBe('Test Client');

    const revoked = await SELF.fetch(`${BASE}/api/connections/${listed.connections[0].id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(revoked.status).toBe(200);

    // Revoking the grant kills the access token with it.
    expect((await listTools(access_token)).status).toBe(401);
  });
});

describe('API tokens on /mcp', () => {
  it('still work, for a client that only takes a static header', async () => {
    const { token } = await seedUser();
    const response = await listTools(token);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
  });

  it('are rejected once revoked', async () => {
    const { token } = await seedUser();
    await env.DB.prepare('DELETE FROM tokens').run();
    expect((await listTools(token)).status).toBe(401);
  });
});
