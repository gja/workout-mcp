import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { captureLoginCode, resetDatabase } from './helpers';

const BASE = 'https://workouts.example';
const EMAIL = 'athlete@example.com';
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
  const response = await postJson('/oauth/register', { client_name: 'Test Client', redirect_uris: redirectUris });
  expect(response.status).toBe(201);
  return (await response.json()) as { client_id: string; client_name: string };
}

async function signIn(): Promise<string> {
  const code = await captureLoginCode(() => postJson('/api/auth/request-code', { email: EMAIL }));
  const response = await postJson('/api/auth/verify', { email: EMAIL, code });
  return response.headers.get('Set-Cookie')!.split(';')[0];
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE verifier and its S256 challenge. */
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64url(digest) };
}

/** Register, sign in, approve, and return the authorization code. */
async function authorizeUpToCode() {
  const client = await registerClient();
  const cookie = await signIn();
  const { verifier, challenge } = await pkce();

  const granted = await postJson(
    '/oauth/authorize',
    { client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, state: 'xyz' },
    { Cookie: cookie },
  );
  expect(granted.status).toBe(200);

  const { redirect } = (await granted.json()) as { redirect: string };
  const target = new URL(redirect);
  expect(target.searchParams.get('state')).toBe('xyz');

  return { client, cookie, verifier, code: target.searchParams.get('code')! };
}

describe('discovery', () => {
  it('publishes protected-resource metadata, at the bare and suffixed paths', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const response = await SELF.fetch(`${BASE}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        resource: `${BASE}/mcp`,
        authorization_servers: [BASE],
      });
    }
  });

  it('publishes authorization-server metadata requiring PKCE', async () => {
    const response = await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`);
    expect(await response.json()).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });
});

describe('client registration', () => {
  it('registers a public client', async () => {
    const client = await registerClient();
    expect(client.client_id).toMatch(/^wkc_[0-9a-f]{32}$/);
    expect(client.client_name).toBe('Test Client');
  });

  it('accepts https and loopback redirect URIs, and nothing else', async () => {
    expect((await postJson('/oauth/register', { redirect_uris: ['https://app.example/cb'] })).status).toBe(201);
    expect((await postJson('/oauth/register', { redirect_uris: ['http://127.0.0.1:9000/cb'] })).status).toBe(201);

    for (const bad of [[], ['http://evil.example/cb'], ['not-a-url'], ['https://app.example/cb#frag']]) {
      const response = await postJson('/oauth/register', { redirect_uris: bad });
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe('authorization', () => {
  it('serves the consent page for a sound request', async () => {
    const client = await registerClient();
    const { challenge } = await pkce();
    const url =
      `${BASE}/oauth/authorize?response_type=code&client_id=${client.client_id}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`;

    const response = await SELF.fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Connect an app');
  });

  it('will not redirect to an unregistered URI, it reports the error instead', async () => {
    const client = await registerClient();
    const response = await SELF.fetch(
      `${BASE}/oauth/authorize?response_type=code&client_id=${client.client_id}` +
        `&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=x&code_challenge_method=S256`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('rejects an unknown client', async () => {
    const response = await SELF.fetch(`${BASE}/oauth/authorize?response_type=code&client_id=wkc_nope`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('sends other errors back to the client, once the redirect URI is trusted', async () => {
    const client = await registerClient();
    const response = await SELF.fetch(
      `${BASE}/oauth/authorize?response_type=code&client_id=${client.client_id}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=abc`,
      { redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location')!);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('abc');
  });

  it('needs a signed-in athlete to approve', async () => {
    const client = await registerClient();
    const response = await postJson('/oauth/authorize', {
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: 'x',
    });
    expect(response.status).toBe(401);
  });
});

describe('token exchange', () => {
  it('trades a code plus verifier for tokens that work on /mcp', async () => {
    const { client, verifier, code } = await authorizeUpToCode();

    const response = await postForm('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
    });
    expect(response.status).toBe(200);

    const tokens = (await response.json()) as { access_token: string; refresh_token: string; token_type: string };
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token).toMatch(/^wko_[0-9a-f]{64}$/);

    const mcp = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(((await mcp.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
  });

  it('rejects a wrong PKCE verifier', async () => {
    const { client, code } = await authorizeUpToCode();
    const response = await postForm('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      code_verifier: 'not-the-verifier',
      client_id: client.client_id,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('burns the code, so a stolen one cannot be replayed', async () => {
    const { client, verifier, code } = await authorizeUpToCode();
    const exchange = () =>
      postForm('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id });

    expect((await exchange()).status).toBe(200);
    expect((await exchange()).status).toBe(400);
  });

  it('refuses an expired code', async () => {
    const { client, verifier, code } = await authorizeUpToCode();
    await env.DB.prepare('UPDATE oauth_codes SET expires_at = ?').bind(new Date(Date.now() - 1000).toISOString()).run();

    const response = await postForm('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.client_id,
    });
    expect(response.status).toBe(400);
  });

  it('rotates the refresh token, retiring the old one', async () => {
    const { client, verifier, code } = await authorizeUpToCode();
    const first = (await (
      await postForm('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id })
    ).json()) as { refresh_token: string };

    const refreshed = await postForm('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: client.client_id,
    });
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // The spent refresh token is dead.
    const replay = await postForm('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: client.client_id,
    });
    expect(replay.status).toBe(400);
  });

  it('rejects an unsupported grant type', async () => {
    const response = await postForm('/oauth/token', { grant_type: 'password' });
    expect(await response.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('lets the athlete revoke a connected app from the dashboard', async () => {
    const { client, verifier, code, cookie } = await authorizeUpToCode();
    const tokens = (await (
      await postForm('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id })
    ).json()) as { access_token: string; refresh_token: string };

    const listed = (await (await SELF.fetch(`${BASE}/api/tokens`, { headers: { Cookie: cookie } })).json()) as {
      tokens: { prefix: string; kind: string }[];
    };
    const connected = listed.tokens.find((token) => token.kind === 'access')!;
    expect(connected).toBeDefined();

    await SELF.fetch(`${BASE}/api/tokens/${connected.prefix}`, { method: 'DELETE', headers: { Cookie: cookie } });

    expect((await SELF.fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
    // Revoking the access token takes its refresh token with it.
    const replay = await postForm('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    });
    expect(replay.status).toBe(400);
  });
});
