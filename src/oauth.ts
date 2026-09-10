/**
 * OAuth 2.1 for MCP clients.
 *
 * This is what lets an MCP client connect with a button rather than a token
 * pasted into a config file. It implements the subset the MCP specification
 * requires: protected-resource and authorization-server metadata (RFC 9728,
 * RFC 8414), dynamic client registration (RFC 7591), and an authorization
 * code flow with mandatory PKCE.
 *
 * Clients are public — no client secret — so PKCE and exact-match redirect
 * URIs are what actually protect the flow.
 */

import type { Env, User } from './db';
import { ACCESS_TOKEN_TTL_DAYS, issueToken, randomHex, sha256 } from './auth';

const CODE_TTL_SECONDS = 60;
const SCOPE = 'workouts';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

const oauthError = (error: string, description: string, status = 400): Response =>
  json({ error, error_description: description }, status);

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** RFC 9728. Tells a client which authorization server guards /mcp. */
export const protectedResourceMetadata = (origin: string) =>
  json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
  });

/** RFC 8414. Everything a client needs to drive the flow. */
export const authorizationServerMetadata = (origin: string) =>
  json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  });

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

type Client = { id: string; name: string; redirect_uris: string[] };

/**
 * A redirect URI must be absolute and either https or loopback — the latter
 * because desktop MCP clients listen on 127.0.0.1 during the flow.
 */
function isUsableRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

export async function registerClient(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return oauthError('invalid_client_metadata', 'expected a JSON body');

  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(isUsableRedirectUri)) {
    return oauthError(
      'invalid_redirect_uri',
      'redirect_uris must be 1-10 absolute https URIs, or http on localhost',
    );
  }

  const client: Client = {
    id: `wkc_${randomHex(16)}`,
    name: typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : 'An MCP client',
    redirect_uris: uris,
  };

  await env.DB.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)')
    .bind(client.id, client.name, JSON.stringify(client.redirect_uris), new Date().toISOString())
    .run();

  return json(
    {
      client_id: client.id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.name,
      redirect_uris: client.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    201,
  );
}

async function findClient(env: Env, id: unknown): Promise<Client | null> {
  if (typeof id !== 'string' || !id) return null;
  const row = await env.DB.prepare('SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?')
    .bind(id)
    .first<{ id: string; name: string; redirect_uris: string }>();
  return row ? { id: row.id, name: row.name, redirect_uris: JSON.parse(row.redirect_uris) as string[] } : null;
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/** Bounce an error back to the client, keeping `state` so it can correlate. */
function redirectError(redirectUri: string, state: string | null, error: string, description: string): Response {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error);
  target.searchParams.set('error_description', description);
  if (state) target.searchParams.set('state', state);
  return Response.redirect(target.toString(), 302);
}

/**
 * The GET half of the flow. Anything wrong with the client or redirect URI is
 * shown here rather than redirected, since an unvalidated redirect target is
 * exactly what an attacker would want. Everything else goes back to the
 * client as an OAuth error.
 *
 * When the request is sound we serve the consent page, which handles login and
 * then posts back to this endpoint.
 */
export async function authorize(request: Request, url: URL, env: Env): Promise<Response> {
  const params = url.searchParams;
  const client = await findClient(env, params.get('client_id'));
  if (!client) return oauthError('invalid_client', 'unknown client_id — register first', 400);

  const redirectUri = params.get('redirect_uri');
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return oauthError('invalid_request', 'redirect_uri does not match one registered by this client', 400);
  }

  const state = params.get('state');
  if (params.get('response_type') !== 'code') {
    return redirectError(redirectUri, state, 'unsupported_response_type', 'only response_type=code is supported');
  }
  if (params.get('code_challenge_method') !== 'S256' || !params.get('code_challenge')) {
    return redirectError(redirectUri, state, 'invalid_request', 'PKCE with code_challenge_method=S256 is required');
  }

  // The consent page reads the query string itself and posts back below.
  return env.ASSETS.fetch(new Request(new URL('/authorize.html', url.origin), { headers: request.headers }));
}

/** The POST half: the athlete is signed in and has approved. */
export async function grantAuthorization(request: Request, env: Env, user: User): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return oauthError('invalid_request', 'expected a JSON body');

  const client = await findClient(env, body.client_id);
  if (!client) return oauthError('invalid_client', 'unknown client_id');

  const redirectUri = body.redirect_uri;
  if (typeof redirectUri !== 'string' || !client.redirect_uris.includes(redirectUri)) {
    return oauthError('invalid_request', 'redirect_uri does not match one registered by this client');
  }
  const challenge = body.code_challenge;
  if (typeof challenge !== 'string' || !challenge) {
    return oauthError('invalid_request', 'code_challenge is required');
  }

  const code = `wkac_${randomHex(32)}`;
  await env.DB.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256(code),
      client.id,
      user.id,
      redirectUri,
      challenge,
      typeof body.resource === 'string' ? body.resource : null,
      new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString(),
    )
    .run();

  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (typeof body.state === 'string' && body.state) target.searchParams.set('state', body.state);
  return json({ redirect: target.toString() });
}

/** What the consent page shows before the athlete approves. */
export async function describeClient(env: Env, clientId: unknown): Promise<Response> {
  const client = await findClient(env, clientId);
  return client ? json({ client_id: client.id, client_name: client.name }) : oauthError('invalid_client', 'unknown client_id', 404);
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** PKCE S256: the challenge is base64url(SHA-256(verifier)). */
async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return base64url(digest) === challenge;
}

/** The token endpoint takes form encoding; some clients send JSON anyway. */
async function readParams(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get('Content-Type') ?? '';
  if (type.includes('application/json')) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]));
  }
  return Object.fromEntries(await request.formData().then((form) => form as unknown as Iterable<[string, string]>));
}

export async function token(request: Request, env: Env): Promise<Response> {
  const params = await readParams(request).catch(() => ({}) as Record<string, string>);

  switch (params.grant_type) {
    case 'authorization_code':
      return exchangeCode(env, params);
    case 'refresh_token':
      return refresh(env, params);
    default:
      return oauthError('unsupported_grant_type', 'expected authorization_code or refresh_token');
  }
}

async function exchangeCode(env: Env, params: Record<string, string>): Promise<Response> {
  if (!params.code || !params.code_verifier) {
    return oauthError('invalid_request', 'code and code_verifier are required');
  }

  const hash = await sha256(params.code);
  const row = await env.DB.prepare(
    'SELECT client_id, user_id, redirect_uri, code_challenge, expires_at FROM oauth_codes WHERE code_hash = ?',
  )
    .bind(hash)
    .first<{ client_id: string; user_id: string; redirect_uri: string; code_challenge: string; expires_at: string }>();

  // Single use: gone whether or not the rest of the checks pass.
  await env.DB.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').bind(hash).run();

  if (!row || Date.parse(row.expires_at) < Date.now()) {
    return oauthError('invalid_grant', 'that authorization code is unknown or expired');
  }
  if (params.client_id && params.client_id !== row.client_id) {
    return oauthError('invalid_grant', 'this code was issued to a different client');
  }
  if (params.redirect_uri && params.redirect_uri !== row.redirect_uri) {
    return oauthError('invalid_grant', 'redirect_uri does not match the authorization request');
  }
  if (!(await pkceMatches(params.code_verifier, row.code_challenge))) {
    return oauthError('invalid_grant', 'code_verifier does not match the code_challenge');
  }

  return issuePair(env, row.user_id, row.client_id);
}

async function refresh(env: Env, params: Record<string, string>): Promise<Response> {
  if (!params.refresh_token) return oauthError('invalid_request', 'refresh_token is required');

  const hash = await sha256(params.refresh_token);
  const row = await env.DB.prepare("SELECT user_id, client_id FROM tokens WHERE token_hash = ? AND kind = 'refresh'")
    .bind(hash)
    .first<{ user_id: string; client_id: string | null }>();
  if (!row) return oauthError('invalid_grant', 'that refresh token is unknown');
  if (params.client_id && row.client_id && params.client_id !== row.client_id) {
    return oauthError('invalid_grant', 'this refresh token was issued to a different client');
  }

  // Rotate: the old refresh token stops working the moment a new one is issued.
  await env.DB.prepare('DELETE FROM tokens WHERE token_hash = ?').bind(hash).run();
  return issuePair(env, row.user_id, row.client_id);
}

async function issuePair(env: Env, userId: string, clientId: string | null): Promise<Response> {
  const access = await issueToken(env, userId, 'access', { clientId, ttlDays: ACCESS_TOKEN_TTL_DAYS });
  const refreshToken = await issueToken(env, userId, 'refresh', { clientId });

  return json({
    access_token: access.token,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_DAYS * 86_400,
    refresh_token: refreshToken.token,
    scope: SCOPE,
  });
}
