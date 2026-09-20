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

/** What a sign-in points at, or the sign-in itself. A linked one owns nothing. */
type Row = { id: string; email: string | null; alias_of_user_id: string | null };

/**
 * The account a sign-in reaches: itself, or the one it was linked to. Asked as a sign-in
 * finishes and nowhere else — everything issued from here on names the account, and a
 * credential from before a link is spent rather than followed. See docs/auth.md.
 *
 * A link whose account has been deleted is the sign-in again, which is the state a
 * hand-deleted account leaves.
 */
async function account(env: Env, row: Row): Promise<User> {
  if (!row.alias_of_user_id) return { id: row.id, email: row.email };
  const linked = await one(
    env,
    qb.selectFrom('users').select(['id', 'email']).where('id', '=', row.alias_of_user_id),
  );
  return linked ?? { id: row.id, email: row.email };
}

/**
 * The account a stored id names, or nothing. A row that has been linked is not an account
 * any more, so a credential made under it before the link stops working rather than
 * quietly becoming someone else's: signing in again is the way back. See docs/auth.md.
 */
export async function findAccount(env: Env, userId: string): Promise<User | null> {
  const row = await one(
    env,
    qb.selectFrom('users').select(['id', 'email', 'alias_of_user_id']).where('id', '=', userId),
  );
  return row && !row.alias_of_user_id ? { id: row.id, email: row.email } : null;
}

/**
 * The first sign-in creates the account; later ones just stamp it. A sign-in with a
 * provider this athlete has not used before is linked to the account whose verified
 * address matches, rather than making a second one. See docs/auth.md.
 */
export async function upsertUser(env: Env, identity: Identity): Promise<User> {
  const now = iso(new Date());
  const verified = identity.email !== null && identity.emailVerified;

  // Asked before the write, because only a sign-in this server has never seen may be
  // linked. A row that already has an account keeps it: an athlete who has two is not
  // made to have one behind their back, and the workouts under the one that would be
  // demoted are not walked away from. See docs/auth.md.
  const known = await one(
    env,
    qb
      .selectFrom('users')
      .select('id')
      .where('provider', '=', identity.provider)
      .where('subject', '=', identity.subject),
  );

  await run(
    env,
    qb
      .insertInto('users')
      .values({
        id: newId(12),
        provider: identity.provider,
        subject: identity.subject,
        email: identity.email,
        email_verified: verified ? 1 : 0,
        created_at: now,
        last_login_at: now,
      })
      .onConflict((clash) =>
        clash.columns(['provider', 'subject']).doUpdateSet((eb) => ({
          // Kept when the new sign-in carries none: Apple sends the address through the
          // browser and can leave it out of a native one, and a blank is not a change.
          email: eb.fn.coalesce(eb.ref('excluded.email'), eb.ref('users.email')),
          email_verified: eb
            .case()
            .when('excluded.email', 'is', null)
            .then(eb.ref('users.email_verified'))
            .else(eb.ref('excluded.email_verified'))
            .end(),
          last_login_at: eb.ref('excluded.last_login_at'),
        })),
      ),
  );

  const row = await one(
    env,
    qb
      .selectFrom('users')
      .select(['id', 'email', 'alias_of_user_id', 'email_verified'])
      .where('provider', '=', identity.provider)
      .where('subject', '=', identity.subject),
  );
  if (!row) throw new Error('user vanished immediately after being written');

  if (known || row.alias_of_user_id || !row.email || !row.email_verified) return account(env, row);
  return account(env, { ...row, alias_of_user_id: await link(env, row.id, now, row.email) });
}

const exists = async (env: Env, id: string): Promise<boolean> =>
  Boolean(await one(env, qb.selectFrom('users').select('id').where('id', '=', id)));

/**
 * The account a **new** sign-in belongs to, where another has already proved the same
 * address — written down, so the answer does not depend on the row still being there.
 *
 * The oldest row wins, and one that is itself linked hands back what it points at, so
 * nothing is ever two hops from its account. Where that account has been deleted by hand,
 * the match is an account again rather than a way into a missing one.
 */
async function link(env: Env, id: string, created: string, email: string): Promise<string | null> {
  const match = await one(
    env,
    qb
      .selectFrom('users')
      .select(['id', 'created_at', 'alias_of_user_id'])
      .where('email', '=', email)
      .where('email_verified', '=', 1)
      .where('id', '!=', id)
      .orderBy('created_at'),
  );
  if (!match) return null;

  const linked = match.alias_of_user_id;
  const linkTo = linked && (await exists(env, linked)) ? linked : match.id;
  if (linkTo === id) return null;

  // Both sides of a simultaneous pair reach this with the other in hand and nothing
  // written yet, so which row is the account cannot be "the one that got here second":
  // they would point at each other and neither would be an account. It is the older row,
  // and the id settles the tie, which is an answer both of them compute the same.
  if (linked === null && (match.created_at > created || (match.created_at === created && match.id > id))) {
    await run(env, qb.updateTable('users').set({ alias_of_user_id: id }).where('id', '=', match.id));
    return null;
  }

  // The match's own account has been deleted by hand, so it is an account again.
  if (linked && linkTo !== linked) {
    await run(env, qb.updateTable('users').set({ alias_of_user_id: null }).where('id', '=', match.id));
  }

  await run(env, qb.updateTable('users').set({ alias_of_user_id: linkTo }).where('id', '=', id));
  return linkTo;
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
      .select([
        'users.id as id',
        'users.email as email',
        // The row this session was made under may have been linked since, and a linked
        // row is no longer an account: the cookie is spent, like an expired one.
        'users.alias_of_user_id as alias_of_user_id',
        'sessions.expires_at as expires_at',
      ])
      .where('sessions.id_hash', '=', await sha256(id)),
  );

  if (!row || row.alias_of_user_id) return null;
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
      .select(['users.id as id', 'users.email as email', 'users.alias_of_user_id as alias_of_user_id'])
      .where('tokens.token_hash', '=', hash),
  );
  // Same as a session: a token issued under a row that has since been linked is spent.
  if (!row || row.alias_of_user_id) return null;

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
