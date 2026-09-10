/**
 * Signing in with Google or Apple.
 *
 * Both are ordinary OpenID Connect authorization-code flows; `arctic` supplies
 * the provider details, including the ES256 client-secret JWT that Apple wants
 * in place of a static secret.
 *
 * Each provider turns on only when its environment variables are set, so a
 * self-hoster can configure Google alone — Apple needs a paid developer
 * account, which is a lot to ask for a personal training log.
 */

import { Apple, Google, generateCodeVerifier, generateState } from 'arctic';
import type { OAuth2Tokens } from 'arctic';
import type { Env } from './db';

export type ProviderName = 'google' | 'apple';

export const PROVIDERS: readonly ProviderName[] = ['google', 'apple'];

export const isProviderName = (value: string): value is ProviderName =>
  (PROVIDERS as readonly string[]).includes(value);

/** Who signed in, as far as the provider is concerned. */
export type Identity = { provider: ProviderName; subject: string; email: string | null; returnTo: string | null };

const LOGIN_STATE_TTL_MINUTES = 10;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const redirectUri = (origin: string, provider: ProviderName): string => `${origin}/auth/${provider}/callback`;

/** Apple's key is stored as base64 PKCS#8 — the .p8 file minus its PEM armour. */
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, ''));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function googleClient(env: Env, origin: string): Google | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return new Google(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, redirectUri(origin, 'google'));
}

function appleClient(env: Env, origin: string): Apple | null {
  if (!env.APPLE_CLIENT_ID || !env.APPLE_TEAM_ID || !env.APPLE_KEY_ID || !env.APPLE_PRIVATE_KEY) return null;
  return new Apple(
    env.APPLE_CLIENT_ID,
    env.APPLE_TEAM_ID,
    env.APPLE_KEY_ID,
    decodeBase64(env.APPLE_PRIVATE_KEY),
    redirectUri(origin, 'apple'),
  );
}

/** Which providers this deployment can actually use. */
export function configuredProviders(env: Env, origin: string): ProviderName[] {
  return PROVIDERS.filter((provider) =>
    provider === 'google' ? googleClient(env, origin) !== null : appleClient(env, origin) !== null,
  );
}

// ---------------------------------------------------------------------------
// Starting a sign-in
// ---------------------------------------------------------------------------

export class LoginError extends Error {}

/**
 * Build the provider's authorization URL and remember the state.
 *
 * The state and PKCE verifier live in D1 rather than a cookie: Apple posts its
 * callback back cross-site, where a `SameSite=Lax` cookie would not be sent.
 * The state is a single-use random value, which is what makes the callback
 * safe to act on.
 */
export async function startLogin(
  env: Env,
  provider: ProviderName,
  origin: string,
  returnTo: string | null = null,
): Promise<string> {
  const state = generateState();
  let authorizationUrl: URL;
  let codeVerifier: string | null = null;

  if (provider === 'google') {
    const client = googleClient(env, origin);
    if (!client) throw new LoginError('Google sign-in is not configured on this server');
    codeVerifier = generateCodeVerifier();
    authorizationUrl = client.createAuthorizationURL(state, codeVerifier, ['openid', 'email']);
  } else {
    const client = appleClient(env, origin);
    if (!client) throw new LoginError('Apple sign-in is not configured on this server');
    authorizationUrl = client.createAuthorizationURL(state, ['email']);
    // Apple insists on a form POST whenever a scope is requested.
    authorizationUrl.searchParams.set('response_mode', 'form_post');
  }

  await env.DB.prepare(
    'INSERT INTO login_states (state, provider, code_verifier, return_to, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(
      state,
      provider,
      codeVerifier,
      safeReturnTo(returnTo),
      new Date(Date.now() + LOGIN_STATE_TTL_MINUTES * 60_000).toISOString(),
    )
    .run();

  return authorizationUrl.toString();
}

/**
 * Only a same-origin path may be returned to, so the sign-in flow cannot be
 * turned into an open redirect.
 */
function safeReturnTo(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  return value.slice(0, 512);
}

/** Consume a state, returning what was stored alongside it. */
async function takeLoginState(
  env: Env,
  provider: ProviderName,
  state: string,
): Promise<{ codeVerifier: string | null; returnTo: string | null }> {
  const row = await env.DB.prepare(
    'SELECT provider, code_verifier, return_to, expires_at FROM login_states WHERE state = ?',
  )
    .bind(state)
    .first<{ provider: string; code_verifier: string | null; return_to: string | null; expires_at: string }>();

  // Single use, whether or not it turns out to be valid.
  await env.DB.prepare('DELETE FROM login_states WHERE state = ?').bind(state).run();

  if (!row || row.provider !== provider || Date.parse(row.expires_at) < Date.now()) {
    throw new LoginError('that sign-in link has expired — please try again');
  }
  return { codeVerifier: row.code_verifier, returnTo: safeReturnTo(row.return_to) };
}

// ---------------------------------------------------------------------------
// Finishing a sign-in
// ---------------------------------------------------------------------------

type IdTokenClaims = { iss?: string; aud?: string | string[]; sub?: string; exp?: number; email?: string };

/**
 * Read the claims out of an ID token.
 *
 * The signature is not checked, and does not need to be: the token came back
 * over TLS from the provider's own token endpoint, in response to a request
 * authenticated with our client secret. OpenID Connect Core 3.1.3.7 allows
 * exactly this. The issuer, audience and expiry are still checked, because
 * those cost nothing and catch a misconfigured client.
 */
function readIdToken(idToken: string, expectedIssuers: string[], clientId: string): IdTokenClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new LoginError('the provider returned a malformed ID token');

  let claims: IdTokenClaims;
  try {
    const payload = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    claims = JSON.parse(payload) as IdTokenClaims;
  } catch {
    throw new LoginError('the provider returned an unreadable ID token');
  }

  if (!claims.sub) throw new LoginError('the provider did not identify the account');
  if (!claims.iss || !expectedIssuers.includes(claims.iss)) throw new LoginError('the ID token came from the wrong issuer');

  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId)) throw new LoginError('the ID token was issued for a different application');
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) throw new LoginError('the ID token has expired');

  return claims;
}

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const APPLE_ISSUERS = ['https://appleid.apple.com'];

/**
 * Arctic throws its own error types when the provider refuses the code or the
 * network fails. Those are expected outcomes here, not bugs, so they become a
 * `LoginError` the athlete can read — with the detail kept in the log.
 */
async function exchange(run: () => Promise<OAuth2Tokens>, provider: ProviderName): Promise<OAuth2Tokens> {
  try {
    return await run();
  } catch (error) {
    console.error(`${provider} token exchange failed`, error);
    throw new LoginError(`${provider} would not complete the sign-in — please try again`);
  }
}

/** Exchange the callback's code for the athlete's identity. */
export async function completeLogin(
  env: Env,
  provider: ProviderName,
  params: URLSearchParams,
  origin: string,
): Promise<Identity> {
  if (params.get('error')) throw new LoginError(`${provider} sign-in was cancelled`);

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) throw new LoginError('that sign-in response was incomplete');

  const { codeVerifier, returnTo } = await takeLoginState(env, provider, state);

  let tokens: OAuth2Tokens;
  let issuers: string[];
  let clientId: string;

  if (provider === 'google') {
    const client = googleClient(env, origin);
    if (!client || !codeVerifier) throw new LoginError('Google sign-in is not configured on this server');
    tokens = await exchange(() => client.validateAuthorizationCode(code, codeVerifier), provider);
    [issuers, clientId] = [GOOGLE_ISSUERS, env.GOOGLE_CLIENT_ID as string];
  } else {
    const client = appleClient(env, origin);
    if (!client) throw new LoginError('Apple sign-in is not configured on this server');
    tokens = await exchange(() => client.validateAuthorizationCode(code), provider);
    [issuers, clientId] = [APPLE_ISSUERS, env.APPLE_CLIENT_ID as string];
  }

  // `idToken()` throws when the provider omitted it, which is a provider
  // problem rather than ours — but it still has to reach the athlete as a
  // readable message rather than a 500.
  let rawIdToken: string;
  try {
    rawIdToken = tokens.idToken();
  } catch {
    throw new LoginError(`${provider} did not return an ID token`);
  }

  const claims = readIdToken(rawIdToken, issuers, clientId);

  return {
    provider,
    subject: claims.sub as string,
    email: claims.email ? claims.email.trim().toLowerCase() : null,
    returnTo,
  };
}

/** Sweep abandoned sign-in attempts. */
export async function pruneLoginStates(env: Env, now: Date = new Date()): Promise<number> {
  const result = await env.DB.prepare('DELETE FROM login_states WHERE expires_at < ?').bind(now.toISOString()).run();
  return result.meta.changes ?? 0;
}
