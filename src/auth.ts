/**
 * Sessions and API tokens.
 *
 * Who the athlete is comes from `identity.ts` (Google or Apple); this module
 * turns that into the two credentials the app uses:
 *
 *   - a browser session cookie, for the dashboard and the consent page;
 *   - an API token (`wk_...`), pasted into a watch app or an MCP client that
 *     only takes a static header.
 *
 * OAuth access and refresh tokens are not here — `@cloudflare/workers-oauth-provider`
 * issues and stores those. `src/index.ts` teaches it to accept `wk_` tokens too.
 */

import type { Env, User } from './db';
import { newId } from './db';
import type { Identity } from './identity';

export const SESSION_TTL_DAYS = 30;

const SESSION_COOKIE = 'workout_session';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const randomHex = (length: number): string => hex(crypto.getRandomValues(new Uint8Array(length)));

export async function sha256(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

const iso = (date: Date): string => date.toISOString();
const inDays = (days: number, from = new Date()): Date => new Date(from.getTime() + days * 86_400_000);

/**
 * An optional allowlist. Anyone with a Google account can reach the sign-in
 * button, so a public deployment usually wants to name who may actually get
 * in. `ALLOWED_EMAILS` takes addresses or `@domain` entries, comma separated;
 * unset means anyone may sign up.
 */
export function isAllowed(env: Env, email: string | null): boolean {
  if (!env.ALLOWED_EMAILS) return true;
  if (!email) return false;
  const domain = email.slice(email.indexOf('@'));
  return env.ALLOWED_EMAILS.split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => entry === email || entry === domain);
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** The first sign-in creates the account; later ones just stamp it. */
export async function upsertUser(env: Env, identity: Identity): Promise<User> {
  const now = iso(new Date());
  await env.DB.prepare(
    `INSERT INTO users (id, provider, subject, email, created_at, last_login_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT (provider, subject) DO UPDATE SET
       email = excluded.email, last_login_at = excluded.last_login_at`,
  )
    .bind(newId(12), identity.provider, identity.subject, identity.email, now)
    .run();

  const user = await env.DB.prepare('SELECT id, email FROM users WHERE provider = ? AND subject = ?')
    .bind(identity.provider, identity.subject)
    .first<User>();
  if (!user) throw new Error('user vanished immediately after being written');
  return user;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession(env: Env, userId: string): Promise<string> {
  const id = randomHex(32);
  await env.DB.prepare('INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(id), userId, iso(inDays(SESSION_TTL_DAYS)), iso(new Date()))
    .run();
  return id;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

export async function readSession(env: Env, request: Request): Promise<User | null> {
  const id = readCookie(request, SESSION_COOKIE);
  if (!id) return null;

  const row = await env.DB.prepare(
    `SELECT users.id AS id, users.email AS email, sessions.expires_at AS expires_at
     FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id_hash = ?`,
  )
    .bind(await sha256(id))
    .first<User & { expires_at: string }>();

  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256(id)).run();
    return null;
  }
  return { id: row.id, email: row.email };
}

export async function endSession(env: Env, request: Request): Promise<void> {
  const id = readCookie(request, SESSION_COOKIE);
  if (id) await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256(id)).run();
}

/** `Secure` is dropped over plain http so the cookie also works on localhost. */
export function sessionCookie(id: string | null, secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE}=${id ?? ''}`,
    'Path=/',
    'HttpOnly',
    // Lax rather than Strict: the OAuth consent page is reached by a
    // top-level navigation from the MCP client.
    'SameSite=Lax',
    id ? `Max-Age=${SESSION_TTL_DAYS * 86_400}` : 'Max-Age=0',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

// ---------------------------------------------------------------------------
// Bearer tokens
// ---------------------------------------------------------------------------

const API_TOKEN_PREFIX = 'wk_';

export type IssuedToken = { token: string; prefix: string };

export async function issueToken(env: Env, userId: string, name?: string | null): Promise<IssuedToken> {
  const token = `${API_TOKEN_PREFIX}${randomHex(32)}`;
  const prefix = token.slice(0, API_TOKEN_PREFIX.length + 6);

  await env.DB.prepare(
    'INSERT INTO tokens (token_hash, user_id, name, prefix, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(await sha256(token), userId, name ?? null, prefix, iso(new Date()))
    .run();

  return { token, prefix };
}

/** Is this one of ours, rather than an OAuth access token? */
export const isApiToken = (token: string): boolean => token.startsWith(API_TOKEN_PREFIX);

/** Resolve an API token to its owner, or null if unknown. */
export async function findTokenOwner(env: Env, token: string): Promise<User | null> {
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT users.id AS id, users.email AS email
     FROM tokens JOIN users ON users.id = tokens.user_id WHERE tokens.token_hash = ?`,
  )
    .bind(hash)
    .first<User>();
  if (!row) return null;

  await env.DB.prepare('UPDATE tokens SET last_used_at = ? WHERE token_hash = ?').bind(iso(new Date()), hash).run();
  return { id: row.id, email: row.email };
}

export type TokenSummary = {
  prefix: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
};

export async function listTokens(env: Env, userId: string): Promise<TokenSummary[]> {
  const { results } = await env.DB.prepare(
    'SELECT prefix, name, created_at, last_used_at FROM tokens WHERE user_id = ? ORDER BY created_at DESC',
  )
    .bind(userId)
    .all<TokenSummary>();
  return results ?? [];
}

export async function revokeToken(env: Env, userId: string, prefix: string): Promise<boolean> {
  const result = await env.DB.prepare('DELETE FROM tokens WHERE user_id = ? AND prefix = ?')
    .bind(userId, prefix)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Sweep expired sessions. Called by the nightly cron. */
export async function pruneExpired(env: Env, now: Date = new Date()): Promise<number> {
  const result = await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(iso(now)).run();
  return result.meta.changes ?? 0;
}
