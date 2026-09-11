// Copying the races an athlete recorded on a training platform into their own
// Google Drive. One pass over the platforms, one file each, nothing kept. See docs/drive.md.

import type { Env, User } from '../db';
import * as platforms from '../platforms';
import type { Competition, RaceSource } from '../platforms';
import { shiftDate, today } from '../units';
import * as google from './google';
import * as store from './store';

export { DriveUnavailable, driveConfigured, serviceAccount } from './google';
export { DriveError } from './google';

/** The top-level folder every copy goes under, so nothing else in the drive is touched. */
export const ROOT_FOLDER = 'workouts-mcp';

/**
 * How far back a run looks for races.
 *
 * Deliberately not the retention window: that window protects the database, and
 * nothing about a race is stored, so it has no bearing here. This is long
 * enough that connecting a drive the week after a race still catches it.
 */
export const LOOKBACK_DAYS = 30;

// Each copy is a download and an upload, and the hourly pass shares one
// invocation's subrequest budget with the completion pass ahead of it. Both are
// deliberately small: a backlog fills in over consecutive hours instead of
// spending a budget that has already been half used.
export const COPY_LIMIT = 3;
export const COPY_BATCH = 5;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// --- Naming -----------------------------------------------------------------

/** Drive allows almost anything in a name; a path separator is the one thing it must not be. */
const safe = (value: string, limit: number): string =>
  value
    .replace(/[\\/\p{C}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, limit) || 'race';

/** `yyyy-mm-dd-<id>-name.fit`, as docs/drive.md spells the path out. */
export const fileName = (race: Competition): string =>
  `${race.date}-${safe(race.remote_id, 40)}-${safe(race.name, 80)}.fit`;

/** `workouts-mcp/yyyy-mm/<platform>/<file>`, for the dashboard and the ledger. */
const pathOf = (label: string, race: Competition): string =>
  `${ROOT_FOLDER}/${race.date.slice(0, 7)}/${label}/${fileName(race)}`;

// --- Configuring ------------------------------------------------------------

export type Drive = google.Drive;

/** Check the service account can actually see the drive before storing it. */
export async function configure(env: Env, user: User, pasted: string): Promise<Drive> {
  if (!google.driveConfigured(env)) throw new google.DriveUnavailable();

  const driveId = google.readDriveId(pasted);
  if (!driveId) throw new google.DriveError('that does not look like a Google Drive link or id');

  const drive = await google.findDrive(await google.accessToken(env), driveId);
  await store.saveConnection(env, user.id, drive.id, drive.name);
  return drive;
}

export const forget = (env: Env, user: User): Promise<boolean> => store.forgetConnection(env, user.id);

export type DriveStatus = {
  /** Whether this deployment has a service account at all. */
  configured: boolean;
  /** The address an athlete shares their drive with, or null when unconfigured. */
  service_account: string | null;
  connected: boolean;
  drive_id: string | null;
  drive_name: string | null;
  last_error: string | null;
  /** Where a race ends up, for the dashboard to show without duplicating the rule. */
  path_template: string;
  copied: number;
  recent: store.Copy[];
  updated_at: string | null;
};

export async function status(env: Env, user: User): Promise<DriveStatus> {
  const connection = await store.findConnection(env, user.id);
  return {
    configured: google.driveConfigured(env),
    service_account: google.serviceAccount(env),
    connected: connection !== null,
    drive_id: connection?.drive_id ?? null,
    drive_name: connection?.drive_name ?? null,
    last_error: connection?.last_error ?? null,
    path_template: `${ROOT_FOLDER}/yyyy-mm/<platform>/yyyy-mm-dd-<id>-name.fit`,
    copied: connection ? await store.countCopies(env, user.id) : 0,
    recent: connection ? await store.recentCopies(env, user.id, 5) : [],
    updated_at: connection?.updated_at ?? null,
  };
}

// --- Copying ----------------------------------------------------------------

export type CopyReport = {
  copied: number;
  /** Races found that this run's budget did not reach; the next pass takes them. */
  remaining: number;
  paths: string[];
  error: string | null;
};

/** One race, relayed from the platform into the drive. The path it landed at. */
async function copyOne(
  env: Env,
  userId: string,
  token: string,
  monthFolderCache: Map<string, string>,
  driveId: string,
  source: RaceSource,
  race: Competition,
): Promise<string> {
  // Cached because a run is usually several races in the same month on the same platform,
  // and each miss is two more subrequests against the budget the copies need.
  const key = `${race.date.slice(0, 7)}/${source.label}`;
  let folderId = monthFolderCache.get(key);
  if (!folderId) {
    const root = await google.ensureFolder(token, driveId, ROOT_FOLDER);
    const month = await google.ensureFolder(token, root, race.date.slice(0, 7));
    folderId = await google.ensureFolder(token, month, source.label);
    monthFolderCache.set(key, folderId);
  }

  const recording = await source.recording(race);
  const fileId = await google.uploadFile(token, {
    parentId: folderId,
    name: fileName(race),
    contentType: recording.content_type,
    body: recording.body,
    length: recording.content_length,
  });

  const path = pathOf(source.label, race);
  await store.recordCopy(env, userId, source.platform, race.remote_id, path, fileId);
  return path;
}

/** Every race not yet copied, oldest first, across every platform that offers them. */
async function pending(env: Env, userId: string): Promise<Array<{ source: RaceSource; race: Competition }>> {
  const to = today();
  const from = shiftDate(to, -LOOKBACK_DAYS);

  const found: Array<{ source: RaceSource; race: Competition }> = [];
  for (const source of await platforms.raceSources(env, userId)) {
    const already = await store.copiedIds(env, userId, source.platform);
    for (const race of await source.races(from, to)) {
      if (!already.has(race.remote_id)) found.push({ source, race });
    }
  }
  return found.sort((left, right) => left.race.date.localeCompare(right.race.date));
}

/** Bring the drive up to date for one athlete. Never throws: the report carries the failure. */
export async function copyNow(env: Env, user: User): Promise<CopyReport> {
  const report: CopyReport = { copied: 0, remaining: 0, paths: [], error: null };

  const connection = await store.findConnection(env, user.id);
  if (!connection) {
    report.error = 'no Google Drive is configured for this account';
    return report;
  }

  try {
    const token = await google.accessToken(env);
    const queue = await pending(env, user.id);
    const folders = new Map<string, string>();

    for (const { source, race } of queue) {
      if (report.copied === COPY_LIMIT) break;
      report.paths.push(await copyOne(env, user.id, token, folders, connection.drive_id, source, race));
      report.copied += 1;
    }
    report.remaining = queue.length - report.copied;

    // The only place a standing error is cleared, and only with nothing left queued.
    await store.recordError(env, user.id, report.remaining > 0 ? `${report.remaining} left to copy` : null);
  } catch (err) {
    report.error = message(err);
    await store.recordError(env, user.id, report.error);
  }
  return report;
}

/** The hourly pass. Errors are per-athlete: one unshared drive must not stop the sweep. */
export async function copyForEveryone(env: Env): Promise<number> {
  if (!google.driveConfigured(env)) return 0;

  let copied = 0;
  for (const { user_id: userId } of await store.connectionBatch(env, COPY_BATCH)) {
    const report = await copyNow(env, { id: userId, email: null });
    copied += report.copied;
  }
  return copied;
}
