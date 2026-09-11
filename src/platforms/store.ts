// Platform connections and the links to what we pushed. The credential is
// encrypted rather than hashed, because it has to be replayed: see docs/integrations.md.

import { retentionWindow } from '../db';
import type { Env } from '../db';
import type { Account, PlatformId } from './types';

/** Connection state as the rest of the app sees it: never the token. */
export type Connection = {
  platform: PlatformId;
  account: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export class CredentialsUnavailable extends Error {
  constructor() {
    super('platform connections are not configured: set the CREDENTIALS_SECRET binding on the Worker');
  }
}

export const credentialsConfigured = (env: Env): boolean => Boolean(env.CREDENTIALS_SECRET);

const IV_BYTES = 12;

async function aesKey(env: Env): Promise<CryptoKey> {
  if (!env.CREDENTIALS_SECRET) throw new CredentialsUnavailable();
  // The secret is a passphrase of any length; SHA-256 makes it the 32 bytes AES-256 wants.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.CREDENTIALS_SECRET));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const fromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

export async function encryptSecret(env: Env, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await aesKey(env),
    new TextEncoder().encode(plaintext),
  );
  return toBase64(new Uint8Array([...iv, ...new Uint8Array(sealed)]));
}

// Never throws: a rotated secret costs a connection, not every write from then on.
export async function decryptSecret(env: Env, stored: string): Promise<string | null> {
  try {
    const bytes = fromBase64(stored);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES) },
      await aesKey(env),
      bytes.slice(IV_BYTES),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

// --- Connections -----------------------------------------------------------

const CONNECTION_COLUMNS = 'platform, account, last_error, created_at, updated_at';

/** Re-authorizing replaces the token, so a fresh grant lands on the same row. */
export async function saveConnection(
  env: Env,
  userId: string,
  platform: PlatformId,
  token: string,
  account: Account,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO platform_connections
       (user_id, platform, secret, account, account_id, last_error, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)
     ON CONFLICT (user_id, platform) DO UPDATE SET
       secret = excluded.secret,
       account = excluded.account, account_id = excluded.account_id,
       last_error = NULL, updated_at = excluded.updated_at`,
  )
    .bind(userId, platform, await encryptSecret(env, token), account.name ?? account.id, account.id, now)
    .run();
}

export async function listConnections(env: Env, userId: string): Promise<Connection[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${CONNECTION_COLUMNS} FROM platform_connections WHERE user_id = ? ORDER BY platform`,
  )
    .bind(userId)
    .all<Connection>();
  return results ?? [];
}

/** Least recently visited first, which is what makes consecutive sweeps work round. */
export async function connectionBatch(
  env: Env,
  platform: PlatformId,
  limit: number,
): Promise<Array<{ user_id: string; token: string | null }>> {
  const { results } = await env.DB.prepare(
    'SELECT user_id, secret FROM platform_connections WHERE platform = ? ORDER BY updated_at LIMIT ?',
  )
    .bind(platform, limit)
    .all<{ user_id: string; secret: string }>();

  return Promise.all(
    (results ?? []).map(async (row) => ({ user_id: row.user_id, token: await decryptSecret(env, row.secret) })),
  );
}

/**
 * Every connection to one upstream account, which a webhook names and nothing else.
 *
 * Deliberately more than one: signing in with intervals.icu makes its own account
 * here, so the same athlete can legitimately be connected to two users. An event
 * concerns all of them. See docs/integrations.md.
 */
export async function connectionsForAccount(
  env: Env,
  platform: PlatformId,
  accountId: string,
): Promise<Array<{ user_id: string; token: string | null }>> {
  const { results } = await env.DB.prepare(
    'SELECT user_id, secret FROM platform_connections WHERE platform = ? AND account_id = ?',
  )
    .bind(platform, accountId)
    .all<{ user_id: string; secret: string }>();

  return Promise.all(
    (results ?? []).map(async (row) => ({ user_id: row.user_id, token: await decryptSecret(env, row.secret) })),
  );
}

/**
 * Whether somebody else here is connected to the same upstream account.
 *
 * Revoking upstream releases the grant for the *app*, not for one token of it, so
 * where one athlete is legitimately connected to two users — signing in with
 * intervals.icu makes its own account — handing the grant back on one disconnect
 * would silently 401 the other. See `disconnect` in `index.ts`.
 */
export async function accountSharedWithOthers(
  env: Env,
  userId: string,
  platform: PlatformId,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS others FROM platform_connections
     WHERE platform = ?1 AND user_id <> ?2 AND account_id IS NOT NULL
       AND account_id = (SELECT account_id FROM platform_connections WHERE user_id = ?2 AND platform = ?1)`,
  )
    .bind(platform, userId)
    .first<{ others: number }>();
  return (row?.others ?? 0) > 0;
}

/** The token in the clear, or null when there is no usable connection. */
export async function credentialFor(env: Env, userId: string, platform: PlatformId): Promise<string | null> {
  const row = await env.DB.prepare('SELECT secret FROM platform_connections WHERE user_id = ? AND platform = ?')
    .bind(userId, platform)
    .first<{ secret: string }>();
  return row ? decryptSecret(env, row.secret) : null;
}

/** Connections with their tokens already decrypted; unreadable ones drop out. */
export async function usableConnections(
  env: Env,
  userId: string,
): Promise<Array<{ platform: PlatformId; token: string }>> {
  const { results } = await env.DB.prepare(
    'SELECT platform, secret FROM platform_connections WHERE user_id = ? ORDER BY platform',
  )
    .bind(userId)
    .all<{ platform: PlatformId; secret: string }>();

  const usable: Array<{ platform: PlatformId; token: string }> = [];
  for (const row of results ?? []) {
    const token = await decryptSecret(env, row.secret);
    if (token) usable.push({ platform: row.platform, token });
  }
  return usable;
}

export async function recordSyncError(
  env: Env,
  userId: string,
  platform: PlatformId,
  message: string | null,
): Promise<void> {
  await env.DB.prepare(
    'UPDATE platform_connections SET last_error = ?, updated_at = ? WHERE user_id = ? AND platform = ?',
  )
    .bind(message, new Date().toISOString(), userId, platform)
    .run();
}

/** Forget the connection and everything we had pushed under it. */
export async function forgetConnection(env: Env, userId: string, platform: PlatformId): Promise<boolean> {
  const result = await env.DB.prepare('DELETE FROM platform_connections WHERE user_id = ? AND platform = ?')
    .bind(userId, platform)
    .run();
  await env.DB.prepare('DELETE FROM platform_links WHERE user_id = ? AND platform = ?').bind(userId, platform).run();
  return (result.meta.changes ?? 0) > 0;
}

// --- Links -----------------------------------------------------------------

export type Link = {
  date: string;
  workout_id: string;
  remote_id: string;
  /** A digest of the plan as it was last pushed. See the migration. */
  fingerprint: string;
  /** The completion already read back off the platform and applied. */
  applied_completion: string | null;
  synced_at: string;
};

const LINK_COLUMNS = 'date, workout_id, remote_id, fingerprint, applied_completion, synced_at';

/** Leaves `applied_completion` alone: re-pushing the plan neither changes nor un-does it. */
export async function saveLink(
  env: Env,
  userId: string,
  platform: PlatformId,
  date: string,
  workoutId: string,
  remoteId: string,
  fingerprint: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO platform_links (user_id, platform, date, workout_id, remote_id, fingerprint, synced_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (user_id, platform, date, workout_id) DO UPDATE SET
       remote_id = excluded.remote_id, fingerprint = excluded.fingerprint, synced_at = excluded.synced_at`,
  )
    .bind(userId, platform, date, workoutId, remoteId, fingerprint, new Date().toISOString())
    .run();
}

export async function findLink(
  env: Env,
  userId: string,
  platform: PlatformId,
  date: string,
  workoutId: string,
): Promise<Link | null> {
  const row = await env.DB.prepare(
    `SELECT ${LINK_COLUMNS} FROM platform_links
     WHERE user_id = ? AND platform = ? AND date = ? AND workout_id = ?`,
  )
    .bind(userId, platform, date, workoutId)
    .first<Link>();
  return row ?? null;
}

/** Every link for a platform, keyed `date/workout_id`, for deciding what is stale. */
export async function listLinks(env: Env, userId: string, platform: PlatformId): Promise<Map<string, Link>> {
  const { results } = await env.DB.prepare(
    `SELECT ${LINK_COLUMNS} FROM platform_links
     WHERE user_id = ? AND platform = ?`,
  )
    .bind(userId, platform)
    .all<Link>();
  return new Map((results ?? []).map((link) => [`${link.date}/${link.workout_id}`, link]));
}

/** The workout a remote id belongs to, for a completion coming back. */
export async function findLinkByRemoteId(
  env: Env,
  userId: string,
  platform: PlatformId,
  remoteId: string,
): Promise<Link | null> {
  const row = await env.DB.prepare(
    `SELECT ${LINK_COLUMNS} FROM platform_links
     WHERE user_id = ? AND platform = ? AND remote_id = ?`,
  )
    .bind(userId, platform, remoteId)
    .first<Link>();
  return row ?? null;
}

export async function dropLink(
  env: Env,
  userId: string,
  platform: PlatformId,
  date: string,
  workoutId: string,
): Promise<void> {
  await env.DB.prepare(
    'DELETE FROM platform_links WHERE user_id = ? AND platform = ? AND date = ? AND workout_id = ?',
  )
    .bind(userId, platform, date, workoutId)
    .run();
}

// A moved workout keeps its remote event. The delete comes first, in the same batch:
// the key moved onto may already hold a link, which the update alone would collide with.
export async function moveLinks(
  env: Env,
  userId: string,
  from: { date: string; id: string },
  to: { date: string; id: string },
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM platform_links WHERE user_id = ? AND date = ? AND workout_id = ?').bind(
      userId,
      to.date,
      to.id,
    ),
    env.DB.prepare(
      `UPDATE platform_links SET date = ?, workout_id = ?
       WHERE user_id = ? AND date = ? AND workout_id = ?`,
    ).bind(to.date, to.id, userId, from.date, from.id),
  ]);
}

/** Remember the completion just read back, so it is never applied twice. */
export async function recordAppliedCompletion(
  env: Env,
  userId: string,
  platform: PlatformId,
  date: string,
  workoutId: string,
  completedAt: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE platform_links SET applied_completion = ?
     WHERE user_id = ? AND platform = ? AND date = ? AND workout_id = ?`,
  )
    .bind(completedAt, userId, platform, date, workoutId)
    .run();
}

export async function countLinks(env: Env, userId: string, platform: PlatformId): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM platform_links WHERE user_id = ? AND platform = ?',
  )
    .bind(userId, platform)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Outside the window only: inside it, a link with no workout is a delete `syncNow` still owes.
export async function pruneOrphanedLinks(env: Env, now: Date = new Date()): Promise<number> {
  const { from, to } = retentionWindow(now);
  const result = await env.DB.prepare(
    `DELETE FROM platform_links WHERE (date < ? OR date > ?) AND NOT EXISTS (
       SELECT 1 FROM workouts
       WHERE workouts.user_id = platform_links.user_id
         AND workouts.date = platform_links.date
         AND workouts.id = platform_links.workout_id
     )`,
  )
    .bind(from, to)
    .run();
  return result.meta.changes ?? 0;
}
