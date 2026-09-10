/**
 * Connecting a Garmin account, over Garmin Connect's OAuth2 PKCE flow.
 *
 * This is a second, unrelated OAuth relationship to the two already in the
 * app, and it is worth being clear about which is which:
 *
 *   - `src/identity.ts` — we are the *client*, of Google or Apple, to find out
 *     who the athlete is.
 *   - `src/index.ts` — we are the *server*, to an MCP client that wants to
 *     read the athlete's workouts.
 *   - this module — we are the *client*, of Garmin, to push workouts into the
 *     athlete's own Connect calendar.
 *
 * Garmin's flow is a plain authorization-code grant with PKCE. It is not
 * OpenID Connect: there is no ID token, and who the athlete is on Garmin's
 * side comes from a separate call once a token is in hand.
 *
 * `arctic` has no Garmin provider, and the flow is small enough that hand
 * writing it is less code than teaching a library about it.
 */

import type { Env } from '../db';

/** Garmin's own endpoints. Fixed rather than configurable: there is one Garmin. */
const AUTHORIZE_URL = 'https://connect.garmin.com/oauth2Confirm';
const TOKEN_URL = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';

/** The Connect API host, which serves both the user and the training APIs. */
export const API_BASE = 'https://apis.garmin.com';

/** How long a half-finished connect flow stays valid. */
export const CONNECT_STATE_TTL_MINUTES = 10;

/**
 * Refresh this long before the access token actually expires.
 *
 * A sync is several calls, and a token that expires between the first and the
 * last would fail the run halfway through with some workouts pushed and some
 * not. Garmin's access tokens last a day, so five minutes of slack costs
 * nothing.
 */
export const REFRESH_MARGIN_MS = 5 * 60_000;

export class GarminAuthError extends Error {}

/** Where Garmin sends the athlete back to. Must match the portal registration. */
export const redirectUri = (origin: string): string => `${origin}/garmin/callback`;

export const isConfigured = (env: Env): boolean =>
  Boolean(env.GARMIN_CLIENT_ID && env.GARMIN_CLIENT_SECRET);

function credentials(env: Env): { id: string; secret: string } {
  if (!env.GARMIN_CLIENT_ID || !env.GARMIN_CLIENT_SECRET) {
    throw new GarminAuthError('Garmin sync is not configured on this server');
  }
  return { id: env.GARMIN_CLIENT_ID, secret: env.GARMIN_CLIENT_SECRET };
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

const base64url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const randomVerifier = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** S256: the challenge is the base64url of the verifier's SHA-256. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Garmin's consent screen, for a state and verifier the caller has stored. */
export async function authorizationUrl(
  env: Env,
  origin: string,
  state: string,
  verifier: string,
): Promise<string> {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', credentials(env).id);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri(origin));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await challengeFor(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** A token pair, with both expiries resolved to absolute instants. */
export type GarminTokens = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string | null;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

const at = (secondsFromNow: number): string => new Date(Date.now() + secondsFromNow * 1000).toISOString();

/**
 * Garmin's token endpoint.
 *
 * Form-encoded, as RFC 6749 asks, and the client secret goes in the body
 * rather than in a Basic header — which is what Garmin's own specification
 * documents.
 */
async function requestTokens(env: Env, params: Record<string, string>): Promise<GarminTokens> {
  const { id, secret } = credentials(env);
  const body = new URLSearchParams({ ...params, client_id: id, client_secret: secret });

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch (error) {
    console.error('garmin token request failed', error);
    throw new GarminAuthError('could not reach Garmin to complete the connection');
  }

  const text = await response.text();
  let payload: TokenResponse = {};
  try {
    payload = JSON.parse(text) as TokenResponse;
  } catch {
    // Garmin answers an outage with HTML, which is worth not pasting into an
    // error message the athlete reads.
  }

  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    console.error(`garmin token request returned ${response.status}`, text.slice(0, 500));
    const detail = payload.error_description ?? payload.error;
    throw new GarminAuthError(
      detail ? `Garmin refused the connection: ${detail}` : `Garmin refused the connection (${response.status})`,
    );
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    // Garmin documents both lifetimes, but a missing one should shorten the
    // token's assumed life rather than extend it: an hour is well inside the
    // day these actually last, so the worst case is one extra refresh.
    accessExpiresAt: at(payload.expires_in ?? 3600),
    refreshExpiresAt: payload.refresh_token_expires_in ? at(payload.refresh_token_expires_in) : null,
  };
}

export const exchangeCode = (env: Env, origin: string, code: string, verifier: string): Promise<GarminTokens> =>
  requestTokens(env, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri(origin),
  });

export const refreshTokens = (env: Env, refreshToken: string): Promise<GarminTokens> =>
  requestTokens(env, { grant_type: 'refresh_token', refresh_token: refreshToken });

// ---------------------------------------------------------------------------
// The athlete, on Garmin's side
// ---------------------------------------------------------------------------

/**
 * Garmin's own id for the connected athlete.
 *
 * Only used for display, so a failure here is not a failure to connect —
 * the caller stores whatever comes back, null included.
 */
export async function fetchGarminUserId(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(`${API_BASE}/wellness-api/rest/user/id`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { userId?: string };
    return payload.userId ?? null;
  } catch (error) {
    console.error('garmin user id lookup failed', error);
    return null;
  }
}

/**
 * Tell Garmin the athlete is done with us.
 *
 * Worth doing on disconnect rather than only dropping our own row: the grant
 * otherwise lingers on Garmin's side, and the athlete sees an app they thought
 * they had removed still listed as connected. A failure is reported but not
 * fatal — our row goes either way, because the athlete asked for it to.
 */
export async function deregister(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/wellness-api/rest/user/registration`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    return response.ok;
  } catch (error) {
    console.error('garmin deregistration failed', error);
    return false;
  }
}
