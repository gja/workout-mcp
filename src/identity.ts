// Sign-in with Google, Apple or intervals.icu, and the one OAuth round that
// connects intervals.icu without a pasted key. See docs/auth.md.

import { Apple, Google, generateCodeVerifier, generateState } from 'arctic';
import type { OAuth2Tokens } from 'arctic';
import type { Env } from './db';

export type ProviderName = 'google' | 'apple' | 'intervals';

export const PROVIDERS: readonly ProviderName[] = ['google', 'apple', 'intervals'];

export const isProviderName = (value: string): value is ProviderName =>
  (PROVIDERS as readonly string[]).includes(value);

/** An intervals.icu access token and whose it is. Their token response carries both. */
export type IntervalsGrant = {
  athlete: { id: string; name: string | null };
  accessToken: string;
  /** What they actually granted, which is not necessarily what was asked for. */
  scope: string;
};

/** Who signed in, as far as the provider is concerned. */
export type Identity = {
  provider: ProviderName;
  subject: string;
  email: string | null;
  /** Whether the provider vouches for the address. Kept for display; nothing authorizes on it. */
  emailVerified: boolean;
  returnTo: string | null;
  /** The token the sign-in itself produced, when the provider is also a training platform. */
  grant?: IntervalsGrant;
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

// Connecting has a callback of its own, which is what tells the two intents apart:
// no flag to carry, and a code meant for one cannot be spent at the other, because
// their token endpoint is given the redirect URI the code was issued for.
export const CONNECT_CALLBACK = '/auth/intervals/connect-callback';

const connectRedirectUri = (origin: string): string => `${origin}${CONNECT_CALLBACK}`;

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

const INTERVALS_AUTHORIZE = 'https://intervals.icu/oauth/authorize';
const INTERVALS_TOKEN = 'https://intervals.icu/api/oauth/token';

// Calendar write pushes the workouts; activity read is completions and the recorded
// files. Nothing needs the athlete profile: their token response names the athlete.
const INTERVALS_SCOPE = 'CALENDAR:WRITE,ACTIVITY:READ';

export const intervalsConfigured = (env: Env): boolean =>
  Boolean(env.INTERVALS_CLIENT_ID && env.INTERVALS_CLIENT_SECRET);

/** Hand-rolled: `arctic` has no intervals.icu provider, and there is no PKCE to do. */
function intervalsAuthorizationUrl(env: Env, state: string, redirect: string): URL {
  const url = new URL(INTERVALS_AUTHORIZE);
  // Required of an authorization endpoint by RFC 6749, and harmless where it is
  // merely assumed: without it a stricter reading of the request is an error page.
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env.INTERVALS_CLIENT_ID as string);
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('scope', INTERVALS_SCOPE);
  url.searchParams.set('state', state);
  return url;
}

/** Which providers this deployment can actually use. */
export function configuredProviders(env: Env, origin: string): ProviderName[] {
  return PROVIDERS.filter((provider) => {
    if (provider === 'google') return googleClient(env, origin) !== null;
    if (provider === 'apple') return appleClient(env, origin) !== null;
    return intervalsConfigured(env);
  });
}

// --- Starting a sign-in ----------------------------------------------------

export class LoginError extends Error {}

/** `user_id` is the intent: set for a connect, null for a sign-in, which has nobody yet. */
async function rememberState(
  env: Env,
  state: string,
  provider: ProviderName,
  codeVerifier: string | null,
  returnTo: string | null,
  userId: string | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO login_states (state, provider, code_verifier, return_to, user_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      state,
      provider,
      codeVerifier,
      safeReturnTo(returnTo),
      userId,
      new Date(Date.now() + LOGIN_STATE_TTL_MINUTES * 60_000).toISOString(),
    )
    .run();
}

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
  } else if (provider === 'apple') {
    const client = appleClient(env, origin);
    if (!client) throw new LoginError('Apple sign-in is not configured on this server');
    authorizationUrl = client.createAuthorizationURL(state, ['email']);
    // Apple insists on a form POST whenever a scope is requested.
    authorizationUrl.searchParams.set('response_mode', 'form_post');
  } else {
    if (!intervalsConfigured(env)) throw new LoginError('intervals.icu sign-in is not configured on this server');
    authorizationUrl = intervalsAuthorizationUrl(env, state, redirectUri(origin, 'intervals'));
  }

  await rememberState(env, state, provider, codeVerifier, returnTo, null);
  return { url: authorizationUrl.toString(), state };
}

/**
 * The same round, for an athlete who is already signed in — however they signed in.
 *
 * Separate from `startLogin` because it must not be reachable without a session:
 * the token it comes back with is hung on `userId`, and nothing about the athlete
 * who authorizes upstream decides who that is.
 */
export async function startConnect(
  env: Env,
  origin: string,
  userId: string,
  returnTo: string | null = null,
): Promise<{ url: string; state: string }> {
  if (!intervalsConfigured(env)) throw new LoginError('intervals.icu is not configured on this server');

  const state = generateState();
  await rememberState(env, state, 'intervals', null, returnTo, userId);
  return { url: intervalsAuthorizationUrl(env, state, connectRedirectUri(origin)).toString(), state };
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
  expect: 'login' | 'connect',
): Promise<{ codeVerifier: string | null; returnTo: string | null; userId: string | null }> {
  const row = await env.DB.prepare(
    'SELECT provider, code_verifier, return_to, user_id, expires_at FROM login_states WHERE state = ?',
  )
    .bind(state)
    .first<{
      provider: string;
      code_verifier: string | null;
      return_to: string | null;
      user_id: string | null;
      expires_at: string;
    }>();

  // Single use, whether or not it turns out to be valid.
  await env.DB.prepare('DELETE FROM login_states WHERE state = ?').bind(state).run();

  if (!row || row.provider !== provider || Date.parse(row.expires_at) < Date.now()) {
    throw new LoginError('that sign-in link has expired — please try again');
  }
  // Whether the row names an athlete *is* the intent, and the two callbacks do
  // different things with the code, so neither may accept the other's state.
  if ((row.user_id ? 'connect' : 'login') !== expect) {
    throw new LoginError('that link does not belong to this page — please try again');
  }
  return { codeVerifier: row.code_verifier, returnTo: safeReturnTo(row.return_to), userId: row.user_id };
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

type IntervalsToken = {
  access_token?: string;
  scope?: string;
  athlete?: { id?: string; name?: string };
  error?: string;
  error_description?: string;
};

/**
 * Their token endpoint: form data in, the athlete inline, no ID token and no email.
 *
 * The code is only good for two minutes, and the redirect URI has to be the one it
 * was issued for — which is what keeps a sign-in code from being spent as a connect.
 */
async function exchangeIntervalsCode(env: Env, code: string, redirect: string): Promise<IntervalsGrant> {
  if (!intervalsConfigured(env)) throw new LoginError('intervals.icu is not configured on this server');

  let response: Response;
  try {
    response = await fetch(INTERVALS_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.INTERVALS_CLIENT_ID as string,
        client_secret: env.INTERVALS_CLIENT_SECRET as string,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirect,
      }),
    });
  } catch (err) {
    throw new LoginError(`could not reach intervals.icu (${(err as Error).message})`);
  }

  const body = (await response.json().catch(() => ({}))) as IntervalsToken;
  if (!response.ok || !body.access_token) {
    // Their own complaint names the cause — an expired code, a redirect URI that is not registered.
    const detail = body.error_description ?? body.error ?? response.status;
    throw new LoginError(`intervals.icu would not issue a token (${detail})`);
  }
  if (!body.athlete?.id) throw new LoginError('intervals.icu did not say which athlete authorized this');

  return {
    athlete: { id: String(body.athlete.id), name: body.athlete.name?.trim() || null },
    accessToken: body.access_token,
    scope: body.scope ?? '',
  };
}

/** The checks both callbacks make before anything is spent. */
async function readCallback(
  env: Env,
  provider: ProviderName,
  params: URLSearchParams,
  cookieState: string | null,
  expect: 'login' | 'connect',
): Promise<{ code: string; returnTo: string | null; codeVerifier: string | null; userId: string | null }> {
  const what = expect === 'login' ? 'sign-in' : 'authorization';
  if (params.get('error')) throw new LoginError(`that ${what} was cancelled`);

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) throw new LoginError(`that ${what} response was incomplete`);

  // This browser's sign-in, not merely this server's: otherwise a victim can be
  // walked through an attacker's callback and land in the attacker's account.
  if (!cookieState || cookieState !== state) {
    throw new LoginError(`that ${what} did not start in this browser — please try again`);
  }

  return { code, ...(await takeLoginState(env, provider, state, expect)) };
}

/** Exchange the callback's code for the athlete's identity. */
export async function completeLogin(
  env: Env,
  provider: ProviderName,
  params: URLSearchParams,
  origin: string,
  cookieState: string | null,
): Promise<Identity> {
  const { code, codeVerifier, returnTo } = await readCallback(env, provider, params, cookieState, 'login');

  // Not OpenID Connect: the identity is the athlete their token response names,
  // and there is no address to go with it. See "intervals.icu" in docs/auth.md.
  if (provider === 'intervals') {
    const grant = await exchangeIntervalsCode(env, code, redirectUri(origin, 'intervals'));
    return { provider, subject: grant.athlete.id, email: null, emailVerified: false, returnTo, grant };
  }

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

/**
 * The connect callback: a token for the athlete who started it, and no session.
 *
 * Nothing here touches `users` or mints a cookie. Connecting intervals.icu is a
 * setting on an account, not a claim about who is using it, so it works the same
 * whether the athlete signed in with Google, Apple or intervals.icu itself.
 */
export async function completeConnect(
  env: Env,
  params: URLSearchParams,
  origin: string,
  cookieState: string | null,
  currentUserId: string,
): Promise<{ grant: IntervalsGrant; returnTo: string | null }> {
  const { code, returnTo, userId } = await readCallback(env, 'intervals', params, cookieState, 'connect');

  // Bound to whoever started it, so following the link in a browser signed in as
  // somebody else hangs the token on nobody rather than on the wrong account.
  if (userId !== currentUserId) {
    throw new LoginError('that authorization was started by a different account — please try again');
  }

  return { grant: await exchangeIntervalsCode(env, code, connectRedirectUri(origin)), returnTo };
}

/** Sweep abandoned sign-in attempts. */
export async function pruneLoginStates(env: Env, now: Date = new Date()): Promise<number> {
  const result = await env.DB.prepare('DELETE FROM login_states WHERE expires_at < ?').bind(now.toISOString()).run();
  return result.meta.changes ?? 0;
}
