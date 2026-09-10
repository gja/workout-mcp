/**
 * Identity: email plus a one-time code, no passwords.
 *
 * Two credentials come out of it:
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
import { sendLoginCode } from './email';

export const SESSION_TTL_DAYS = 30;
export const CODE_TTL_MINUTES = 10;
/** How long before a second code may be requested for the same address. */
export const CODE_COOLDOWN_SECONDS = 60;
export const MAX_CODE_ATTEMPTS = 5;

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
const inMinutes = (minutes: number, from = new Date()): Date => new Date(from.getTime() + minutes * 60_000);

/** A six-digit code, drawn without modulo bias. */
export function newLoginCode(): string {
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= 4_294_000_000); // largest multiple of 1e6 below 2^32
  return String(buffer[0] % 1_000_000).padStart(6, '0');
}

/** Deliberately narrow: enough to catch typos, not to police the RFC. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

/**
 * An optional allowlist, because an open sign-up form on a personal service is
 * an invitation to burn someone else's email quota. `ALLOWED_EMAILS` takes
 * addresses or `@domain` entries, comma separated; unset means open.
 */
export function isAllowed(env: Env, email: string): boolean {
  if (!env.ALLOWED_EMAILS) return true;
  const domain = email.slice(email.indexOf('@'));
  return env.ALLOWED_EMAILS.split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => entry === email || entry === domain);
}

// ---------------------------------------------------------------------------
// Login codes
// ---------------------------------------------------------------------------

export type LoginRequest = { ok: true } | { ok: false; status: number; error: string; retryAfter?: number };

export async function requestLoginCode(env: Env, rawEmail: unknown, appName: string): Promise<LoginRequest> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, status: 400, error: 'that does not look like an email address' };
  if (!isAllowed(env, email)) return { ok: false, status: 403, error: 'that address is not allowed to sign in here' };

  const existing = await env.DB.prepare('SELECT created_at FROM login_codes WHERE email = ?')
    .bind(email)
    .first<{ created_at: string }>();

  if (existing) {
    const age = (Date.now() - Date.parse(existing.created_at)) / 1000;
    if (age < CODE_COOLDOWN_SECONDS) {
      const retryAfter = Math.ceil(CODE_COOLDOWN_SECONDS - age);
      return { ok: false, status: 429, error: `a code was just sent; try again in ${retryAfter}s`, retryAfter };
    }
  }

  const code = newLoginCode();
  await env.DB.prepare(
    `INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?1, ?2, ?3, 0, ?4)
     ON CONFLICT (email) DO UPDATE SET
       code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at`,
  )
    .bind(email, await sha256(code), iso(inMinutes(CODE_TTL_MINUTES)), iso(new Date()))
    .run();

  await sendLoginCode(env, email, code, appName);
  return { ok: true };
}

export type VerifyResult = { ok: true; user: User } | { ok: false; status: number; error: string };

export async function verifyLoginCode(env: Env, rawEmail: unknown, rawCode: unknown): Promise<VerifyResult> {
  const email = normalizeEmail(rawEmail);
  const code = typeof rawCode === 'string' ? rawCode.trim().replace(/\s/g, '') : '';
  if (!email || !/^\d{6}$/.test(code)) return { ok: false, status: 400, error: 'enter the six-digit code' };

  const row = await env.DB.prepare('SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?')
    .bind(email)
    .first<{ code_hash: string; expires_at: string; attempts: number }>();

  const wrong = { ok: false as const, status: 400, error: 'that code is wrong or has expired' };
  if (!row) return wrong;

  // Burn the code on expiry or too many guesses, so it cannot be ground down.
  if (Date.parse(row.expires_at) < Date.now() || row.attempts >= MAX_CODE_ATTEMPTS) {
    await env.DB.prepare('DELETE FROM login_codes WHERE email = ?').bind(email).run();
    return wrong;
  }

  if ((await sha256(code)) !== row.code_hash) {
    await env.DB.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
    return wrong;
  }

  await env.DB.prepare('DELETE FROM login_codes WHERE email = ?').bind(email).run();
  return { ok: true, user: await upsertUser(env, email) };
}

/** First verified login creates the account; later ones just stamp it. */
async function upsertUser(env: Env, email: string): Promise<User> {
  const now = iso(new Date());
  await env.DB.prepare(
    `INSERT INTO users (id, email, created_at, last_login_at) VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT (email) DO UPDATE SET last_login_at = excluded.last_login_at`,
  )
    .bind(newId(12), email, now)
    .run();

  const user = await env.DB.prepare('SELECT id, email FROM users WHERE email = ?').bind(email).first<User>();
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

/** Sweep expired sessions and login codes. Called by the nightly cron. */
export async function pruneExpired(env: Env, now: Date = new Date()): Promise<number> {
  const stamp = iso(now);
  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(stamp),
    env.DB.prepare('DELETE FROM login_codes WHERE expires_at < ?').bind(stamp),
  ]);
  return results.reduce((total, result) => total + (result.meta.changes ?? 0), 0);
}
