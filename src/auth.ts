// Session cookies and `wk_` API tokens, hashed. OAuth tokens are the library's. See docs/auth.md.

import type { Env, User } from './db';
import { newId } from './db';
import { all, changes, one, qb, run } from './sql';
import type { Identity } from './identity';

export const SESSION_TTL_DAYS = 30;

const SESSION_COOKIE = 'workout_session';

// --- Primitives ------------------------------------------------------------

export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const randomHex = (length: number): string => hex(crypto.getRandomValues(new Uint8Array(length)));

export async function sha256(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

const iso = (date: Date): string => date.toISOString();
const inDays = (days: number, from = new Date()): Date => new Date(from.getTime() + days * 86_400_000);

// Compared as digests, so the work is fixed-length whatever the inputs were: a
// plain `===` on a shared secret leaks its length and its matching prefix.
export async function secretsMatch(given: string | null, expected: string | undefined): Promise<boolean> {
  if (!given || !expected) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let same = 0;
  for (let at = 0; at < a.length; at += 1) same |= a.charCodeAt(at) ^ b.charCodeAt(at);
  return same === 0;
}

// --- Accounts --------------------------------------------------------------

/** The first sign-in creates the account; later ones just stamp it. */
export async function upsertUser(env: Env, identity: Identity): Promise<User> {
  const now = iso(new Date());
  await run(
    env,
    qb
      .insertInto('users')
      .values({
        id: newId(12),
        provider: identity.provider,
        subject: identity.subject,
        email: identity.email,
        created_at: now,
        last_login_at: now,
      })
      .onConflict((clash) =>
        clash.columns(['provider', 'subject']).doUpdateSet((eb) => ({
          email: eb.ref('excluded.email'),
          last_login_at: eb.ref('excluded.last_login_at'),
        })),
      ),
  );

  const user = await one(
    env,
    qb
      .selectFrom('users')
      .select(['id', 'email'])
      .where('provider', '=', identity.provider)
      .where('subject', '=', identity.subject),
  );
  if (!user) throw new Error('user vanished immediately after being written');
  return user;
}

// --- Sessions --------------------------------------------------------------

export async function createSession(env: Env, userId: string): Promise<string> {
  const id = randomHex(32);
  await run(
    env,
    qb.insertInto('sessions').values({
      id_hash: await sha256(id),
      user_id: userId,
      expires_at: iso(inDays(SESSION_TTL_DAYS)),
      created_at: iso(new Date()),
    }),
  );
  return id;
}

export function readCookie(request: Request, name: string): string | null {
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

  const row = await one(
    env,
    qb
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .select(['users.id as id', 'users.email as email', 'sessions.expires_at as expires_at'])
      .where('sessions.id_hash', '=', await sha256(id)),
  );

  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    await run(env, qb.deleteFrom('sessions').where('id_hash', '=', await sha256(id)));
    return null;
  }
  return { id: row.id, email: row.email };
}

export async function endSession(env: Env, request: Request): Promise<void> {
  const id = readCookie(request, SESSION_COOKIE);
  if (id) await run(env, qb.deleteFrom('sessions').where('id_hash', '=', await sha256(id)));
}

/** `Secure` is dropped over plain http so the cookie also works on localhost. */
export function sessionCookie(id: string | null, secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE}=${id ?? ''}`,
    'Path=/',
    'HttpOnly',
    // Lax, not Strict: the consent page is a top-level navigation from the MCP client.
    'SameSite=Lax',
    id ? `Max-Age=${SESSION_TTL_DAYS * 86_400}` : 'Max-Age=0',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

// --- Bearer tokens ---------------------------------------------------------

const API_TOKEN_PREFIX = 'wk_';

export type IssuedToken = { token: string; prefix: string };

export async function issueToken(env: Env, userId: string, name?: string | null): Promise<IssuedToken> {
  const token = `${API_TOKEN_PREFIX}${randomHex(32)}`;
  const prefix = token.slice(0, API_TOKEN_PREFIX.length + 6);

  await run(
    env,
    qb.insertInto('tokens').values({
      token_hash: await sha256(token),
      user_id: userId,
      name: name ?? null,
      prefix,
      created_at: iso(new Date()),
    }),
  );

  return { token, prefix };
}

/** Is this one of ours, rather than an OAuth access token? */
export const isApiToken = (token: string): boolean => token.startsWith(API_TOKEN_PREFIX);

export async function findTokenOwner(env: Env, token: string): Promise<User | null> {
  const hash = await sha256(token);
  const row = await one(
    env,
    qb
      .selectFrom('tokens')
      .innerJoin('users', 'users.id', 'tokens.user_id')
      .select(['users.id as id', 'users.email as email'])
      .where('tokens.token_hash', '=', hash),
  );
  if (!row) return null;

  await run(env, qb.updateTable('tokens').set({ last_used_at: iso(new Date()) }).where('token_hash', '=', hash));
  return { id: row.id, email: row.email };
}

export type TokenSummary = {
  prefix: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
};

export async function listTokens(env: Env, userId: string): Promise<TokenSummary[]> {
  return all(
    env,
    qb
      .selectFrom('tokens')
      .select(['prefix', 'name', 'created_at', 'last_used_at'])
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc'),
  );
}

export async function revokeToken(env: Env, userId: string, prefix: string): Promise<boolean> {
  const written = await changes(
    env,
    qb.deleteFrom('tokens').where('user_id', '=', userId).where('prefix', '=', prefix),
  );
  return written > 0;
}

export async function pruneExpired(env: Env, now: Date = new Date()): Promise<number> {
  return changes(env, qb.deleteFrom('sessions').where('expires_at', '<', iso(now)));
}
