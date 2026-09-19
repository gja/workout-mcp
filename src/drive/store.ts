// The athlete's drive, and the ledger of sessions already copied to it. Nothing about
// a session itself is written here — only that it went.

import type { Env } from '../db';
import { all, changes, one, qb, run } from '../sql';

/** Drive state as the rest of the app sees it. */
export type DriveConnection = {
  drive_id: string;
  drive_name: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS = ['drive_id', 'drive_name', 'last_error', 'created_at', 'updated_at'] as const;

export async function saveConnection(env: Env, userId: string, driveId: string, driveName: string): Promise<void> {
  const now = new Date().toISOString();
  await run(
    env,
    qb
      .insertInto('drive_connections')
      .values({
        user_id: userId,
        drive_id: driveId,
        drive_name: driveName,
        last_error: null,
        created_at: now,
        updated_at: now,
      })
      // A fresh drive clears the last failure: it was the old one's.
      .onConflict((clash) =>
        clash.column('user_id').doUpdateSet((eb) => ({
          drive_id: eb.ref('excluded.drive_id'),
          drive_name: eb.ref('excluded.drive_name'),
          last_error: null,
          updated_at: eb.ref('excluded.updated_at'),
        })),
      ),
  );
}

export async function findConnection(env: Env, userId: string): Promise<DriveConnection | null> {
  return one(env, qb.selectFrom('drive_connections').select([...COLUMNS]).where('user_id', '=', userId));
}

/** Least recently visited first, which is what makes consecutive sweeps work round. */
export async function connectionBatch(env: Env, limit: number): Promise<Array<{ user_id: string }>> {
  return all(env, qb.selectFrom('drive_connections').select('user_id').orderBy('updated_at').limit(limit));
}

export async function recordError(env: Env, userId: string, message: string | null): Promise<void> {
  await run(
    env,
    qb
      .updateTable('drive_connections')
      .set({ last_error: message, updated_at: new Date().toISOString() })
      .where('user_id', '=', userId),
  );
}

/** Forget the drive. The files already in it are the athlete's, and are left alone. */
export async function forgetConnection(env: Env, userId: string): Promise<boolean> {
  const written = await changes(env, qb.deleteFrom('drive_connections').where('user_id', '=', userId));
  await run(env, qb.deleteFrom('drive_copies').where('user_id', '=', userId));
  return written > 0;
}

// --- The ledger -------------------------------------------------------------

export type Copy = { platform: string; remote_id: string; path: string; copied_at: string };

/** Sessions already copied or claimed, for one sync run. A claim counts: it is being copied. */
export async function copiedIds(env: Env, userId: string, platform: string): Promise<Set<string>> {
  const rows = await all(
    env,
    qb.selectFrom('drive_copies').select('remote_id').where('user_id', '=', userId).where('platform', '=', platform),
  );
  return new Set(rows.map((row) => row.remote_id));
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
  const written = await changes(
    env,
    qb
      .insertInto('drive_copies')
      .values({
        user_id: userId,
        platform,
        remote_id: remoteId,
        path,
        file_id: null,
        copied_at: new Date().toISOString(),
      })
      .onConflict((clash) => clash.columns(['user_id', 'platform', 'remote_id']).doNothing()),
  );
  return written > 0;
}

/** The upload landed: name the file, which is also what marks the claim finished. */
export async function completeCopy(
  env: Env,
  userId: string,
  platform: string,
  remoteId: string,
  fileId: string,
): Promise<void> {
  await run(
    env,
    qb
      .updateTable('drive_copies')
      .set({ file_id: fileId })
      .where('user_id', '=', userId)
      .where('platform', '=', platform)
      .where('remote_id', '=', remoteId),
  );
}

/** Give the session back, so a claim whose upload failed is retried rather than lost. */
export async function releaseCopy(env: Env, userId: string, platform: string, remoteId: string): Promise<void> {
  await run(
    env,
    qb
      .deleteFrom('drive_copies')
      .where('user_id', '=', userId)
      .where('platform', '=', platform)
      .where('remote_id', '=', remoteId)
      .where('file_id', 'is', null),
  );
}

// `file_id IS NOT NULL` throughout: a claim still in flight is not a file yet.
export async function recentCopies(env: Env, userId: string, limit: number): Promise<Copy[]> {
  return all(
    env,
    qb
      .selectFrom('drive_copies')
      .select(['platform', 'remote_id', 'path', 'copied_at'])
      .where('user_id', '=', userId)
      .where('file_id', 'is not', null)
      .orderBy('copied_at', 'desc')
      .limit(limit),
  );
}

export async function countCopies(env: Env, userId: string): Promise<number> {
  const row = await one(
    env,
    qb
      .selectFrom('drive_copies')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('user_id', '=', userId)
      .where('file_id', 'is not', null),
  );
  return row?.n ?? 0;
}
