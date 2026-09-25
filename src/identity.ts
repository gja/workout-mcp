// Sign-in with Google or Apple, and the one OAuth round that connects intervals.icu
// without a pasted key. See docs/auth.md.

import { Apple, Google, generateCodeVerifier, generateState } from 'arctic';
import type { OAuth2Tokens } from 'arctic';
import type { Env } from './db';
import { changes, one, qb, run } from './sql';

// `intervals` names a connect round and the accounts its old sign-in made; it no longer
// signs anyone in.
export type ProviderName = 'google' | 'apple' | 'intervals';

export type SignInProvider = Exclude<ProviderName, 'intervals'>;

export const PROVIDERS: readonly SignInProvider[] = ['google', 'apple'];

export const isProviderName = (value: string): value is SignInProvider =>
  (PROVIDERS as readonly string[]).includes(value);

/** An intervals.icu access token and whose it is. Their token response carries both. */
export type IntervalsGrant = {
  athlete: { id: string; name: string | null };
  accessToken: string;
  /** What they actually granted, which is not necessarily what was asked for. */
  scope: string;
};

export type Identity = {
  provider: ProviderName;
  subject: string;
  email: string | null;
  /** Whether the provider vouches for the address. Kept for display; nothing authorizes on it. */
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

// Connecting has a callback of its own, which is what tells the two intents apart: a
// code meant for one cannot be spent at the other, since the token endpoint is given the
// redirect URI the code was issued for.
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

/** Arctic owns the web flow's exchange; the native one is ours, below. */
const APPLE_TOKEN = 'https://appleid.apple.com/auth/token';

export const appleAppConfigured = (env: Env): boolean =>
  Boolean(env.APPLE_APP_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY);

const INTERVALS_AUTHORIZE = 'https://intervals.icu/oauth/authorize';
const INTERVALS_TOKEN = 'https://intervals.icu/api/oauth/token';

// Calendar write pushes the workouts; activity write covers reading completions and
// recorded files *and* writing the post-workout comment. One permission per resource:
// naming `ACTIVITY:READ` alongside it is refused with "Duplicate scope ACTIVITY".
const INTERVALS_SCOPE = 'CALENDAR:WRITE,ACTIVITY:WRITE';

export const intervalsConfigured = (env: Env): boolean =>
  Boolean(env.INTERVALS_CLIENT_ID && env.INTERVALS_CLIENT_SECRET);

/** Hand-rolled: `arctic` has no intervals.icu provider, and there is no PKCE to do. */
function intervalsAuthorizationUrl(env: Env, state: string, redirect: string): URL {
  const url = new URL(INTERVALS_AUTHORIZE);
  // Required by RFC 6749 and harmless where it is merely assumed.
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env.INTERVALS_CLIENT_ID as string);
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('scope', INTERVALS_SCOPE);
  url.searchParams.set('state', state);
  return url;
}

export function configuredProviders(env: Env, origin: string): SignInProvider[] {
  return PROVIDERS.filter((provider) =>
    provider === 'google' ? googleClient(env, origin) !== null : appleClient(env, origin) !== null,
  );
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
  await run(
    env,
    qb.insertInto('login_states').values({
      state,
      provider,
      code_verifier: codeVerifier,
      return_to: safeReturnTo(returnTo),
      user_id: userId,
      expires_at: new Date(Date.now() + LOGIN_STATE_TTL_MINUTES * 60_000).toISOString(),
    }),
  );
}

/** Remembers the state in D1 *and* in a cookie; `completeLogin` insists on both. */
export async function startLogin(
  env: Env,
  provider: SignInProvider,
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

  await rememberState(env, state, provider, codeVerifier, returnTo, null);
  return { url: authorizationUrl.toString(), state };
}

/**
 * The same round for an athlete already signed in. Separate from `startLogin` because it
 * must not be reachable without a session: the token is hung on `userId`, and nothing
 * about who authorizes upstream decides who that is.
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

async function takeLoginState(
  env: Env,
  provider: ProviderName,
  state: string,
  expect: 'login' | 'connect',
): Promise<{ codeVerifier: string | null; returnTo: string | null; userId: string | null }> {
  const row = await one(
    env,
    qb
      .selectFrom('login_states')
      .select(['provider', 'code_verifier', 'return_to', 'user_id', 'expires_at'])
      .where('state', '=', state),
  );

  // Single use, whether or not it turns out to be valid.
  await run(env, qb.deleteFrom('login_states').where('state', '=', state));

  if (!row || row.provider !== provider || Date.parse(row.expires_at) < Date.now()) {
    throw new LoginError('that sign-in link has expired — please try again');
  }
  // Whether the row names an athlete *is* the intent, so neither callback may accept
  // the other's state.
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
 * Form data in, the athlete inline, no ID token and no email. The code is good for two
 * minutes, and the redirect URI has to be the one it was issued for.
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

export async function completeLogin(
  env: Env,
  provider: SignInProvider,
  params: URLSearchParams,
  origin: string,
  cookieState: string | null,
): Promise<Identity> {
  const { code, codeVerifier, returnTo } = await readCallback(env, provider, params, cookieState, 'login');

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

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/**
 * The ES256 JWT Apple takes in place of a client secret. `arctic` builds one too, but only
 * inside an exchange that always sends a `redirect_uri` — which the native client has none
 * of, and Apple refuses the pair. Same team, same key, a different `sub`.
 */
async function appleClientSecret(env: Env, clientId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    decodeBase64(env.APPLE_PRIVATE_KEY as string),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const issued = Math.floor(Date.now() / 1000);
  const encode = (part: object) => base64url(new TextEncoder().encode(JSON.stringify(part)));
  const signed = `${encode({ typ: 'JWT', alg: 'ES256', kid: env.APPLE_KEY_ID })}.${encode({
    iss: env.APPLE_TEAM_ID,
    iat: issued,
    exp: issued + 300,
    aud: 'https://appleid.apple.com',
    sub: clientId,
  })}`;

  // Raw, which for ECDSA is the r‖s a JWS signature is; DER would need unpacking.
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signed),
  );
  return `${signed}.${base64url(new Uint8Array(signature))}`;
}

/**
 * The native sign-in's other half: the authorization code an `ASAuthorizationAppleIDCredential`
 * carries, spent here rather than on the phone, because spending it needs the team's key.
 *
 * The ID token still arrives over TLS from Apple's own token endpoint against our client
 * secret, so it is read the way every other one here is. The audience is the app's bundle
 * id rather than the Services ID, and the subject is the same either way — Apple scopes it
 * to the team. See docs/auth.md.
 */
export async function completeAppleAppLogin(env: Env, code: string): Promise<Identity> {
  if (!appleAppConfigured(env)) throw new LoginError('the app sign-in is not configured on this server');
  const clientId = env.APPLE_APP_ID as string;

  let response: Response;
  try {
    response = await fetch(APPLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      // No `redirect_uri`: the app is the client, and there is nowhere to come back to.
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: await appleClientSecret(env, clientId),
      }),
    });
  } catch (err) {
    console.error('apple app token exchange failed', err);
    throw new LoginError('Apple would not complete the sign-in — please try again');
  }

  const body = (await response.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!response.ok || !body.id_token) {
    console.error('apple app token exchange refused', response.status, body.error);
    throw new LoginError('Apple would not complete the sign-in — please try again');
  }

  const claims = readIdToken(body.id_token, APPLE_ISSUERS, clientId);
  return {
    provider: 'apple',
    subject: claims.sub as string,
    email: claims.email ? claims.email.trim().toLowerCase() : null,
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    returnTo: null,
  };
}

/**
 * A token for the athlete who started it, and no session: connecting is a setting on an
 * account rather than a claim about who is using it, so nothing here touches `users`.
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

export async function pruneLoginStates(env: Env, now: Date = new Date()): Promise<number> {
  return changes(env, qb.deleteFrom('login_states').where('expires_at', '<', now.toISOString()));
}
