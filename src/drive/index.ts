// Copying the sessions an athlete recorded on a training platform into their own
// Google Drive. One pass over the platforms, one file each, nothing kept.
//
// Nothing routes here: this runs from the hourly cron in `src/index.ts` and from
// nowhere else, for the athletes whose `drive_connections` row is already there.
// `src/recordings/` is what a caller reaches for instead.

import type { Env, User } from '../db';
import * as platforms from '../platforms';
import type { ActivitySource, Recorded } from '../platforms';
import { fileName, safe } from '../recordings';
import { shiftDate, today } from '../units';
import * as google from './google';
import * as store from './store';

export { DriveUnavailable, driveConfigured, serviceAccount } from './google';
export { DriveError } from './google';

/** The top-level folder every copy goes under, so nothing else in the drive is touched. */
export const ROOT_FOLDER = 'workouts-mcp';

/**
 * How far back a run looks for sessions to copy.
 *
 * Deliberately not the retention window: that window protects the database, and
 * nothing about the session itself is stored, so it has no bearing here. This is
 * long enough that connecting a drive weeks later still catches what came before.
 */
export const LOOKBACK_DAYS = 30;

// Each copy is a download and an upload, on top of up to six folder lookups on
// a cold run, so a batch of three athletes at three sessions each is about forty
// subrequests — inside the 50 a Worker gets on the free plan. The pass has its
// own cron for exactly that reason: see "Scheduled work" in docs/deployment.md.
//
// Every recorded session is copied, not only the races, so the queue after a
// drive is first connected is a month of training rather than a handful of
// events. It clears over consecutive hourly runs, and `remaining` says so.
export const COPY_LIMIT = 3;
export const COPY_BATCH = 3;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// --- Naming -----------------------------------------------------------------

// The file's own name is `src/recordings/`: a copy landing here and a copy
// leaving in an archive are the same file by two routes, and they are named once.
export { fileName };

/** `workouts-mcp/<platform>/yyyy-mm/<file>`, for the ledger. */
const pathOf = (label: string, recorded: Recorded): string =>
  `${ROOT_FOLDER}/${label}/${recorded.date.slice(0, 7)}/${fileName(recorded)}`;

// --- Configuring ------------------------------------------------------------

export type Drive = google.Drive;

/**
 * Check the service account can actually *write* to the drive before storing it.
 *
 * Reading is not enough to prove anything useful: a Viewer, or a My Drive folder
 * a service account has no quota to own files in, reads fine and then fails
 * every copy. Making the root folder is the cheapest honest test, and it is a
 * folder the first copy would have had to make anyway.
 */
export async function configure(env: Env, user: User, pasted: string): Promise<Drive> {
  if (!google.driveConfigured(env)) throw new google.DriveUnavailable();

  const driveId = google.readDriveId(pasted);
  if (!driveId) throw new google.DriveError('that does not look like a Google Drive link or id');

  const token = await google.accessToken(env);
  const drive = await google.findDrive(token, driveId);
  await google.ensureFolder(token, drive.id, ROOT_FOLDER);

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
  /** Where a copy ends up, for the dashboard to show without duplicating the rule. */
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
    path_template: `${ROOT_FOLDER}/<platform>/yyyy-mm/yyyy-mm-dd-<id>-<name>.fit`,
    copied: connection ? await store.countCopies(env, user.id) : 0,
    recent: connection ? await store.recentCopies(env, user.id, 5) : [],
    updated_at: connection?.updated_at ?? null,
  };
}

// --- Copying ----------------------------------------------------------------

export type CopyReport = {
  copied: number;
  /** Sessions found that this run's budget did not reach; the next pass takes them. */
  remaining: number;
  paths: string[];
  error: string | null;
};

/** One session, relayed from the platform into the drive. The path it landed at, or null if taken. */
async function copyOne(
  env: Env,
  userId: string,
  token: string,
  folderCache: Map<string, string>,
  driveId: string,
  source: ActivitySource,
  recorded: Recorded,
): Promise<string | null> {
  const path = pathOf(source.label, recorded);

  // Claimed before a byte moves, so an overlapping run cannot upload it too.
  if (!(await store.claimCopy(env, userId, source.platform, recorded.remote_id, path))) return null;

  try {
    // Cached because a run is usually several sessions in the same month on the same
    // platform, and each miss is up to six more subrequests against the copies' budget.
    const month = recorded.date.slice(0, 7);
    const key = `${source.label}/${month}`;
    let folderId = folderCache.get(key);
    if (!folderId) {
      const root = await google.ensureFolder(token, driveId, ROOT_FOLDER);
      const platform = await google.ensureFolder(token, root, safe(source.label, 60));
      folderId = await google.ensureFolder(token, platform, month);
      folderCache.set(key, folderId);
    }

    const recording = await source.recording(recorded);
    const fileId = await google.uploadFile(token, {
      parentId: folderId,
      name: fileName(recorded),
      contentType: recording.content_type,
      body: recording.body,
      length: recording.content_length,
    });

    await store.completeCopy(env, userId, source.platform, recorded.remote_id, fileId);
    return path;
  } catch (err) {
    // The claim goes back: a download that failed is one to try again, not one to forget.
    await store.releaseCopy(env, userId, source.platform, recorded.remote_id);
    throw err;
  }
}

/** Every recorded session not yet copied, oldest first, across every platform offering them. */
async function pending(env: Env, userId: string): Promise<Array<{ source: ActivitySource; recorded: Recorded }>> {
  const to = today();
  const from = shiftDate(to, -LOOKBACK_DAYS);

  const found: Array<{ source: ActivitySource; recorded: Recorded }> = [];
  for (const source of await platforms.activitySources(env, userId)) {
    const already = await store.copiedIds(env, userId, source.platform);
    for (const recorded of await source.activities(from, to)) {
      if (!already.has(recorded.remote_id)) found.push({ source, recorded });
    }
  }
  return found.sort((left, right) => left.recorded.date.localeCompare(right.recorded.date));
}

/** Bring the drive up to date for one athlete. Never throws: the report carries the failure. */
export async function copyNow(env: Env, user: User): Promise<CopyReport> {
  const report: CopyReport = { copied: 0, remaining: 0, paths: [], error: null };

  // Before anything is attempted: a deployment with no service account is not a drive failure.
  if (!google.driveConfigured(env)) {
    report.error = new google.DriveUnavailable().message;
    return report;
  }

  const connection = await store.findConnection(env, user.id);
  if (!connection) {
    report.error = 'no Google Drive is configured for this account';
    return report;
  }

  try {
    const token = await google.accessToken(env);
    const queue = await pending(env, user.id);
    const folders = new Map<string, string>();

    let reached = 0;
    let refused: string | null = null;
    for (const { source, recorded } of queue) {
      if (reached === COPY_LIMIT) break;
      reached += 1;
      try {
        const path = await copyOne(env, user.id, token, folders, connection.drive_id, source, recorded);
        // Null means another run claimed it between the queue being built and now.
        if (path === null) continue;
        report.paths.push(path);
        report.copied += 1;
      } catch (err) {
        // Per session, not per run: every recorded session is queued now, and some of
        // them have no file to fetch at all — a manual entry, or one that came from
        // Strava with no streams to build a FIT from. Aborting here would park the
        // queue on that session for good, because it is rebuilt oldest-first every
        // pass and would fail at the same place. `copyOne` has already handed the
        // claim back, so it is still owed; the rest of the batch moves meanwhile,
        // and the lookback drops the session for good after `LOOKBACK_DAYS`.
        refused = message(err);
      }
    }
    report.remaining = queue.length - reached;
    report.error = refused;

    // A backlog is not a failure: it clears itself next hour, so it never becomes a
    // standing error the dashboard would report as "Last copy failed".
    await store.recordError(env, user.id, refused);
  } catch (err) {
    report.error = message(err);
    await store.recordError(env, user.id, report.error);
  }
  return report;
}

/** The hourly drive pass. Errors are per-athlete: one unshared drive must not stop the sweep. */
export async function copyForEveryone(env: Env): Promise<number> {
  if (!google.driveConfigured(env)) return 0;

  let copied = 0;
  for (const { user_id: userId } of await store.connectionBatch(env, COPY_BATCH)) {
    const report = await copyNow(env, { id: userId, email: null });
    copied += report.copied;
  }
  return copied;
}
