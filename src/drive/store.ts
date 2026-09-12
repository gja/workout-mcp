// The athlete's drive, and the ledger of sessions already copied to it. Nothing about
// a session itself is written here — only that it went.

import type { Env } from '../db';

/** Drive state as the rest of the app sees it. */
export type DriveConnection = {
  drive_id: string;
  drive_name: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS = 'drive_id, drive_name, last_error, created_at, updated_at';

export async function saveConnection(env: Env, userId: string, driveId: string, driveName: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO drive_connections (user_id, drive_id, drive_name, last_error, created_at, updated_at)
     VALUES (?1, ?2, ?3, NULL, ?4, ?4)
     ON CONFLICT (user_id) DO UPDATE SET
       drive_id = excluded.drive_id, drive_name = excluded.drive_name,
       last_error = NULL, updated_at = excluded.updated_at`,
  )
    .bind(userId, driveId, driveName, now)
    .run();
}

export async function findConnection(env: Env, userId: string): Promise<DriveConnection | null> {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM drive_connections WHERE user_id = ?`)
    .bind(userId)
    .first<DriveConnection>();
  return row ?? null;
}

/** Least recently visited first, which is what makes consecutive sweeps work round. */
export async function connectionBatch(env: Env, limit: number): Promise<Array<{ user_id: string }>> {
  const { results } = await env.DB.prepare(
    'SELECT user_id FROM drive_connections ORDER BY updated_at LIMIT ?',
  )
    .bind(limit)
    .all<{ user_id: string }>();
  return results ?? [];
}

export async function recordError(env: Env, userId: string, message: string | null): Promise<void> {
  await env.DB.prepare('UPDATE drive_connections SET last_error = ?, updated_at = ? WHERE user_id = ?')
    .bind(message, new Date().toISOString(), userId)
    .run();
}

/** Forget the drive. The files already in it are the athlete's, and are left alone. */
export async function forgetConnection(env: Env, userId: string): Promise<boolean> {
  const result = await env.DB.prepare('DELETE FROM drive_connections WHERE user_id = ?').bind(userId).run();
  await env.DB.prepare('DELETE FROM drive_copies WHERE user_id = ?').bind(userId).run();
  return (result.meta.changes ?? 0) > 0;
}

// --- The ledger -------------------------------------------------------------

export type Copy = { platform: string; remote_id: string; path: string; copied_at: string };

/** Sessions already copied or claimed, for one sync run. A claim counts: it is being copied. */
export async function copiedIds(env: Env, userId: string, platform: string): Promise<Set<string>> {
  const { results } = await env.DB.prepare(
    'SELECT remote_id FROM drive_copies WHERE user_id = ? AND platform = ?',
  )
    .bind(userId, platform)
    .all<{ remote_id: string }>();
  return new Set((results ?? []).map((row) => row.remote_id));
}

/**
 * Take the session, or find that someone else already has it.
 *
 * Written *before* the upload, not after: "Copy now" can overlap the hourly
 * pass, and two runs that each checked an empty ledger first would both upload
 * — Drive allows duplicate names, so that is two files, one of them orphaned.
 * The primary key decides it instead, and `file_id` stays null until it lands.
 */
export async function claimCopy(
  env: Env,
  userId: string,
  platform: string,
  remoteId: string,
  path: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO drive_copies (user_id, platform, remote_id, path, file_id, copied_at)
     VALUES (?1, ?2, ?3, ?4, NULL, ?5)
     ON CONFLICT (user_id, platform, remote_id) DO NOTHING`,
  )
    .bind(userId, platform, remoteId, path, new Date().toISOString())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** The upload landed: name the file, which is also what marks the claim finished. */
export async function completeCopy(
  env: Env,
  userId: string,
  platform: string,
  remoteId: string,
  fileId: string,
): Promise<void> {
  await env.DB.prepare(
    'UPDATE drive_copies SET file_id = ? WHERE user_id = ? AND platform = ? AND remote_id = ?',
  )
    .bind(fileId, userId, platform, remoteId)
    .run();
}

/** Give the session back, so a claim whose upload failed is retried rather than lost. */
export async function releaseCopy(env: Env, userId: string, platform: string, remoteId: string): Promise<void> {
  await env.DB.prepare(
    'DELETE FROM drive_copies WHERE user_id = ? AND platform = ? AND remote_id = ? AND file_id IS NULL',
  )
    .bind(userId, platform, remoteId)
    .run();
}

// `file_id IS NOT NULL` throughout: a claim still in flight is not a file yet.
export async function recentCopies(env: Env, userId: string, limit: number): Promise<Copy[]> {
  const { results } = await env.DB.prepare(
    `SELECT platform, remote_id, path, copied_at FROM drive_copies
     WHERE user_id = ? AND file_id IS NOT NULL ORDER BY copied_at DESC LIMIT ?`,
  )
    .bind(userId, limit)
    .all<Copy>();
  return results ?? [];
}

export async function countCopies(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM drive_copies WHERE user_id = ? AND file_id IS NOT NULL',
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
