// OpenID Connect sign-in with Google or Apple, via `arctic`. See docs/auth.md.

import { Apple, Google, generateCodeVerifier, generateState } from 'arctic';
import type { OAuth2Tokens } from 'arctic';
import type { Env } from './db';

export type ProviderName = 'google' | 'apple';

export const PROVIDERS: readonly ProviderName[] = ['google', 'apple'];

export const isProviderName = (value: string): value is ProviderName =>
  (PROVIDERS as readonly string[]).includes(value);

/** Who signed in, as far as the provider is concerned. */
export type Identity = {
  provider: ProviderName;
  subject: string;
  email: string | null;
  /** Whether the provider vouches for the address. `ALLOWED_EMAILS` needs a fact, not a claim. */
  emailVerified: boolean;
  returnTo: string | null;
};

const LOGIN_STATE_TTL_MINUTES = 10;

/** Names the in-flight sign-in in the browser that started it. */
export const LOGIN_COOKIE = 'workout_login';

// Ties the callback to this browser, not just to this server. See docs/auth.md.
// `None` for Apple's cross-site POST; only valid with `Secure`, so http falls back to `Lax`.
export function loginCookie(state: string | null, secure: boolean): string {
  const attributes = [
    `${LOGIN_COOKIE}=${state ?? ''}`,
    'Path=/auth',
    'HttpOnly',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    state ? `Max-Age=${LOGIN_STATE_TTL_MINUTES * 60}` : 'Max-Age=0',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

// --- Configuration ---------------------------------------------------------

const redirectUri = (origin: string, provider: ProviderName): string => `${origin}/auth/${provider}/callback`;

/** Apple's key is base64 PKCS#8 — the .p8 file, with or without its PEM armour. */
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

// --- Starting a sign-in ----------------------------------------------------

export class LoginError extends Error {}

/** Remembers the state in D1 *and* in a cookie; `completeLogin` insists on both. */
export async function startLogin(
  env: Env,
  provider: ProviderName,
  origin: string,
  returnTo: string | null = null,
): Promise<{ url: string; state: string }> {
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

  return { url: authorizationUrl.toString(), state };
}

/** Same-origin paths only, so sign-in cannot be turned into an open redirect. */
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

// --- Finishing a sign-in ---------------------------------------------------

type IdTokenClaims = {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  email?: string;
  /** Google sends a boolean, Apple a string. */
  email_verified?: boolean | string;
};

// Unsigned by design — OIDC Core 3.1.3.7; see docs/auth.md. Issuer, audience and expiry still checked.
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

/** Arctic's own errors are expected outcomes here, so they become readable ones. */
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
  cookieState: string | null,
): Promise<Identity> {
  if (params.get('error')) throw new LoginError(`${provider} sign-in was cancelled`);

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) throw new LoginError('that sign-in response was incomplete');

  // This browser's sign-in, not merely this server's: otherwise a victim can be
  // walked through an attacker's callback and land in the attacker's account.
  if (!cookieState || cookieState !== state) {
    throw new LoginError('that sign-in did not start in this browser — please try again');
  }

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

  // Throws when the provider omitted it — their problem, but not a 500 for the athlete.
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
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    returnTo,
  };
}

/** Sweep abandoned sign-in attempts. */
export async function pruneLoginStates(env: Env, now: Date = new Date()): Promise<number> {
  const result = await env.DB.prepare('DELETE FROM login_states WHERE expires_at < ?').bind(now.toISOString()).run();
  return result.meta.changes ?? 0;
}
