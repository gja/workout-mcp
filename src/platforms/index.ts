// Keeping the athlete's plan in step with their connected platforms. See docs/integrations.md.

import { sha256 } from '../auth';
import * as db from '../db';
import type { Env, User } from '../db';
import type { Workout } from '../workout';
import { intervals } from './intervals';
import * as store from './store';
import type { Account, Competition, Completion, Platform, PlatformId, RecordedFile } from './types';
import { PlatformError } from './types';

export { CredentialsUnavailable, credentialsConfigured } from './store';
export type { Connection } from './store';
export { PlatformError } from './types';
export type { Competition, PlatformId, RecordedFile } from './types';

export const PLATFORMS: Record<PlatformId, Platform> = { intervals };

export const isPlatformId = (value: string): value is PlatformId =>
  Object.prototype.hasOwnProperty.call(PLATFORMS, value);

/** Below the Worker's outbound subrequest cap; a big first sync spans several runs. */
export const PUSH_LIMIT = 40;

/** The upsert key upstream: built from ids alone, so an edit or a move cannot change it. */
const syncKey = (userId: string, workout: Pick<Workout, 'id'>): string => `workout-mcp-${userId}-${workout.id}`;

// Decides what is stale. Not `updated_at`: a completion read back off a platform bumps that.
const fingerprint = (workout: Workout): Promise<string> =>
  sha256(
    JSON.stringify([
      workout.date,
      workout.name,
      workout.sport,
      workout.sub_sport ?? null,
      workout.notes ?? null,
      workout.steps,
    ]),
  );

const message = (err: unknown): string =>
  err instanceof PlatformError || err instanceof Error ? err.message : String(err);

// --- Connecting ------------------------------------------------------------

/** Check the credential works before storing it, so a typo fails here and now. */
export async function connect(env: Env, user: User, platformId: PlatformId, key: string): Promise<Account> {
  // Before the key is sent anywhere: nowhere to store it means nobody else sees it either.
  if (!store.credentialsConfigured(env)) throw new store.CredentialsUnavailable();

  const platform = PLATFORMS[platformId];
  const account = await platform.verify(key.trim());
  await store.saveConnection(env, user.id, platformId, key.trim(), account.name ?? account.id);
  return account;
}

export const disconnect = (env: Env, user: User, platformId: PlatformId): Promise<boolean> =>
  store.forgetConnection(env, user.id, platformId);

export type PlatformStatus = {
  id: PlatformId;
  label: string;
  credential: Platform['credential'];
  connected_note: string | null;
  connected: boolean;
  account: string | null;
  last_error: string | null;
  synced: number;
  updated_at: string | null;
};

/** Every platform, connected or not, as the dashboard shows them. */
export async function status(env: Env, user: User): Promise<PlatformStatus[]> {
  const connections = new Map(
    (await store.listConnections(env, user.id)).map((connection) => [connection.platform, connection]),
  );

  return Promise.all(
    Object.values(PLATFORMS).map(async (platform) => {
      const connection = connections.get(platform.id);
      return {
        id: platform.id,
        label: platform.label,
        credential: platform.credential,
        connected_note: platform.connected_note ?? null,
        connected: connection !== undefined,
        account: connection?.account ?? null,
        last_error: connection?.last_error ?? null,
        synced: connection ? await store.countLinks(env, user.id, platform.id) : 0,
        updated_at: connection?.updated_at ?? null,
      };
    }),
  );
}

// --- Pushing ---------------------------------------------------------------

/** One workout to one platform, with the link kept up to date. */
async function pushOne(
  env: Env,
  userId: string,
  platform: Platform,
  key: string,
  workout: Workout,
): Promise<void> {
  const remoteId = await platform.push(key, { workout, syncKey: syncKey(userId, workout) });
  await store.saveLink(env, userId, platform.id, workout.date, workout.id, remoteId, await fingerprint(workout));
}

/** Nothing in here may fail the athlete's own write — the bookkeeping included. */
async function sideEffect(what: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error(`platform sync failed while ${what}`, err);
  }
}

/** A workout was created or replaced; `previous` is where it was, when the write moved it. */
export async function onWorkoutSaved(
  env: Env,
  user: User,
  workout: Workout,
  previous?: { date: string; id: string },
): Promise<void> {
  await sideEffect(`saving ${workout.date}/${workout.id}`, async () => {
    if (previous && (previous.date !== workout.date || previous.id !== workout.id)) {
      await store.moveLinks(env, user.id, previous, { date: workout.date, id: workout.id });
    }

    for (const { platform: platformId, key } of await store.usableConnections(env, user.id)) {
      const platform = PLATFORMS[platformId];
      if (!platform) continue;
      try {
        await pushOne(env, user.id, platform, key, workout);
      } catch (err) {
        await store.recordSyncError(env, user.id, platformId, `“${workout.name}” on ${workout.date}: ${message(err)}`);
      }
    }
  });
}

/** A workout was deleted here, so it should go from the platforms too. */
export async function onWorkoutDeleted(env: Env, user: User, date: string, id: string): Promise<void> {
  await sideEffect(`deleting ${date}/${id}`, async () => {
    for (const { platform: platformId, key } of await store.usableConnections(env, user.id)) {
      const platform = PLATFORMS[platformId];
      if (!platform) continue;

      const link = await store.findLink(env, user.id, platformId, date, id);
      if (!link) continue;
      try {
        await platform.remove(key, link.remote_id);
        await store.dropLink(env, user.id, platformId, date, id);
      } catch (err) {
        // The link stays: it is the only record of the event still to remove.
        await store.recordSyncError(env, user.id, platformId, `deleting ${date}/${id}: ${message(err)}`);
      }
    }
  });
}

export type SyncReport = {
  platform: PlatformId;
  pushed: number;
  removed: number;
  remaining: number;
  completed: number;
  error: string | null;
};

/** Bring a platform back into step, and read completions back. See docs/integrations.md. */
export async function syncNow(env: Env, user: User, platformId: PlatformId): Promise<SyncReport> {
  const report: SyncReport = { platform: platformId, pushed: 0, removed: 0, remaining: 0, completed: 0, error: null };

  try {
    const key = await store.credentialFor(env, user.id, platformId);
    if (!key) {
      report.error = 'no usable credential for this platform; connect it again';
      await store.recordSyncError(env, user.id, platformId, report.error);
      return report;
    }
    const platform = PLATFORMS[platformId];

    const workouts = await db.listWorkouts(env, user.id);
    const links = await store.listLinks(env, user.id, platformId);
    const stored = new Set(workouts.map((workout) => `${workout.date}/${workout.id}`));

    // A link naming no workout, inside the window, is a delete that never landed.
    const window = db.retentionWindow();
    const abandoned = [...links.entries()]
      .filter(([keyed, link]) => !stored.has(keyed) && link.date >= window.from && link.date <= window.to)
      .map(([, link]) => link);

    const stale: Workout[] = [];
    for (const workout of workouts) {
      const link = links.get(`${workout.date}/${workout.id}`);
      if (!link || link.fingerprint !== (await fingerprint(workout))) stale.push(workout);
    }

    // One budget across both, since either is an outbound call.
    let budget = PUSH_LIMIT;
    for (const link of abandoned) {
      if (budget === 0) break;
      budget -= 1;
      await platform.remove(key, link.remote_id);
      await store.dropLink(env, user.id, platformId, link.date, link.workout_id);
      report.removed += 1;
    }
    for (const workout of stale) {
      if (budget === 0) break;
      budget -= 1;
      await pushOne(env, user.id, platform, key, workout);
      report.pushed += 1;
    }
    report.remaining = abandoned.length - report.removed + (stale.length - report.pushed);

    report.completed = await applyCompletions(env, user.id, platformId, key);
    // The only place a standing error is cleared, and only with nothing left queued.
    await store.recordSyncError(env, user.id, platformId, report.remaining > 0 ? `${report.remaining} left to sync` : null);
  } catch (err) {
    report.error = message(err);
    await store.recordSyncError(env, user.id, platformId, report.error);
  }
  return report;
}

// --- Completions coming back -----------------------------------------------

// Straight to the db, and once each: see "Completion is polled" in docs/integrations.md.
async function applyCompletions(env: Env, userId: string, platformId: PlatformId, key: string): Promise<number> {
  const window = db.readWindow();
  const completions: Completion[] = await PLATFORMS[platformId].completions(key, window.from, window.to);

  let marked = 0;
  for (const completion of completions) {
    const link = await store.findLinkByRemoteId(env, userId, platformId, completion.remote_id);
    if (!link || link.applied_completion === completion.completed_at) continue;
    if (!(await db.getWorkout(env, userId, link.date, link.workout_id))) continue;

    await db.setCompleted(env, userId, link.date, link.workout_id, completion.completed_at);
    await store.recordAppliedCompletion(
      env,
      userId,
      platformId,
      link.date,
      link.workout_id,
      completion.completed_at,
    );
    marked += 1;
  }
  return marked;
}

/** Athletes per scheduled pass; the next one carries on. See `store.connectionBatch`. */
export const PULL_BATCH = 40;

/** How many stuck connections the nightly retry takes on. */
export const RETRY_BATCH = 10;

/** The hourly pass. Errors are per-athlete, and every connection visited is stamped. */
export async function pullEveryCompletion(env: Env): Promise<number> {
  let marked = 0;
  for (const platformId of Object.keys(PLATFORMS) as PlatformId[]) {
    for (const connection of await store.connectionBatch(env, platformId, PULL_BATCH)) {
      const key = await store.decryptSecret(env, connection.secret);
      if (!key) {
        await store.recordSyncError(
          env,
          connection.user_id,
          platformId,
          'the stored key could not be read back; connect the platform again',
        );
        continue;
      }
      try {
        marked += await applyCompletions(env, connection.user_id, platformId, key);
      } catch (err) {
        await store.recordSyncError(env, connection.user_id, platformId, message(err));
      }
    }
  }
  return marked;
}

/** The nightly retry. Nothing else picks these up — a later write pushes only itself. */
export async function retryFailedConnections(env: Env): Promise<number> {
  let fixed = 0;
  for (const connection of await store.failedConnections(env, RETRY_BATCH)) {
    if (!isPlatformId(connection.platform)) continue;
    const report = await syncNow(env, { id: connection.user_id, email: null }, connection.platform);
    if (!report.error) fixed += 1;
  }
  return fixed;
}

/** Drop links to workouts gone for good. Outside the window only; inside, `syncNow` has them. */
export const pruneOrphanedLinks = store.pruneOrphanedLinks;

// --- Races, for anything that wants the recording itself ---------------------

/** One platform's races, credential already in hand. What `src/drive/` is handed. */
export type RaceSource = {
  platform: PlatformId;
  /** Names the folder a race lands in, so the destination never learns a platform id. */
  label: string;
  races(from: string, to: string): Promise<Competition[]>;
  recording(competition: Competition): Promise<RecordedFile>;
};

/** Only platforms that offer races, and only where the athlete's key still reads back. */
export async function raceSources(env: Env, userId: string): Promise<RaceSource[]> {
  const sources: RaceSource[] = [];
  for (const { platform: platformId, key } of await store.usableConnections(env, userId)) {
    const platform = PLATFORMS[platformId] as Platform | undefined;
    if (!platform?.competitions || !platform.recording) continue;
    sources.push({
      platform: platformId,
      label: platform.label,
      races: platform.competitions.bind(platform, key),
      recording: platform.recording.bind(platform, key),
    });
  }
  return sources;
}
