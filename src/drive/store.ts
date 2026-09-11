// The athlete's drive, and the ledger of races already copied to it. Nothing about
// a race itself is written here — only that it went. See docs/drive.md.

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

/** The platform ids a race has already been copied under, for one sync run. */
export async function copiedIds(env: Env, userId: string, platform: string): Promise<Set<string>> {
  const { results } = await env.DB.prepare(
    'SELECT remote_id FROM drive_copies WHERE user_id = ? AND platform = ?',
  )
    .bind(userId, platform)
    .all<{ remote_id: string }>();
  return new Set((results ?? []).map((row) => row.remote_id));
}

/** Ignores a second write for the same race: the first copy is the one that counts. */
export async function recordCopy(
  env: Env,
  userId: string,
  platform: string,
  remoteId: string,
  path: string,
  fileId: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO drive_copies (user_id, platform, remote_id, path, file_id, copied_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (user_id, platform, remote_id) DO NOTHING`,
  )
    .bind(userId, platform, remoteId, path, fileId, new Date().toISOString())
    .run();
}

export async function recentCopies(env: Env, userId: string, limit: number): Promise<Copy[]> {
  const { results } = await env.DB.prepare(
    `SELECT platform, remote_id, path, copied_at FROM drive_copies
     WHERE user_id = ? ORDER BY copied_at DESC LIMIT ?`,
  )
    .bind(userId, limit)
    .all<Copy>();
  return results ?? [];
}

export async function countCopies(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM drive_copies WHERE user_id = ?')
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
