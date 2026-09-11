// Keeping the athlete's plan in step with their connected platforms. See docs/integrations.md.

import { sha256 } from '../auth';
import * as db from '../db';
import type { Env, User } from '../db';
import { intervalsConfigured } from '../identity';
import type { Workout } from '../workout';
import { intervals } from './intervals';
import * as store from './store';
import type { Account, Completion, Platform, PlatformId, Recorded, RecordedFile } from './types';
import { PlatformError } from './types';

export { CredentialsUnavailable, credentialsConfigured } from './store';
export type { Connection } from './store';
export { PlatformError } from './types';
export type { Account, PlatformId, Recorded, RecordedFile } from './types';

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

/**
 * Store the token an OAuth round came back with.
 *
 * Nothing is checked against the platform first: their token endpoint answered
 * with the athlete it belongs to, so asking who it is would only repeat what we
 * were already told. What *is* checked first is that there is somewhere safe to
 * put it — nowhere to store it means nobody else sees it either.
 */
export async function connect(
  env: Env,
  user: User,
  platformId: PlatformId,
  token: string,
  account: Account,
): Promise<void> {
  if (!store.credentialsConfigured(env)) throw new store.CredentialsUnavailable();
  await store.saveConnection(env, user.id, platformId, token, account);
}

/** Handed back upstream first, where the platform offers it: see `revoke` in `types.ts`. */
export async function disconnect(env: Env, user: User, platformId: PlatformId): Promise<boolean> {
  const platform = PLATFORMS[platformId] as Platform | undefined;
  const token = await store.credentialFor(env, user.id, platformId);

  if (platform?.revoke && token) {
    // Never fails the disconnect: a grant we cannot hand back is still one the
    // athlete asked us to forget, and they can revoke it from their own settings.
    await platform.revoke(token).catch((err: unknown) => {
      console.error(`releasing the ${platformId} credential failed`, err);
    });
  }
  return store.forgetConnection(env, user.id, platformId);
}

export type PlatformStatus = {
  id: PlatformId;
  label: string;
  connect: Platform['connect'];
  connected_note: string | null;
  connected: boolean;
  account: string | null;
  /** Whether this deployment was given the platform's OAuth client at all. */
  oauth: boolean;
  last_error: string | null;
  synced: number;
  updated_at: string | null;
};

// The mapping lives here rather than on the adapter: whether this deployment was
// given the platform's OAuth client is not the adapter's business.
const oauthOnOffer = (env: Env, platformId: PlatformId): boolean =>
  platformId === 'intervals' && intervalsConfigured(env);

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
        connect: platform.connect,
        connected_note: platform.connected_note ?? null,
        connected: connection !== undefined,
        account: connection?.account ?? null,
        oauth: oauthOnOffer(env, platform.id),
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
  token: string,
  workout: Workout,
): Promise<void> {
  const remoteId = await platform.push(token, { workout, syncKey: syncKey(userId, workout) });
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

    for (const { platform: platformId, token } of await store.usableConnections(env, user.id)) {
      const platform = PLATFORMS[platformId];
      if (!platform) continue;
      try {
        await pushOne(env, user.id, platform, token, workout);
      } catch (err) {
        await store.recordSyncError(env, user.id, platformId, `“${workout.name}” on ${workout.date}: ${message(err)}`);
      }
    }
  });
}

/** A workout was deleted here, so it should go from the platforms too. */
export async function onWorkoutDeleted(env: Env, user: User, date: string, id: string): Promise<void> {
  await sideEffect(`deleting ${date}/${id}`, async () => {
    for (const { platform: platformId, token } of await store.usableConnections(env, user.id)) {
      const platform = PLATFORMS[platformId];
      if (!platform) continue;

      const link = await store.findLink(env, user.id, platformId, date, id);
      if (!link) continue;
      try {
        await platform.remove(token, link.remote_id);
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
    const token = await store.credentialFor(env, user.id, platformId);
    if (!token) {
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
      await platform.remove(token, link.remote_id);
      await store.dropLink(env, user.id, platformId, link.date, link.workout_id);
      report.removed += 1;
    }
    for (const workout of stale) {
      if (budget === 0) break;
      budget -= 1;
      await pushOne(env, user.id, platform, token, workout);
      report.pushed += 1;
    }
    report.remaining = abandoned.length - report.removed + (stale.length - report.pushed);

    report.completed = await applyCompletions(env, user.id, platformId, token);
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
async function applyCompletions(
  env: Env,
  userId: string,
  platformId: PlatformId,
  token: string,
): Promise<number> {
  const window = db.readWindow();
  const completions: Completion[] = await PLATFORMS[platformId].completions(token, window.from, window.to);

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

/**
 * A platform said one of its athletes recorded something: read their completions now.
 *
 * The event is a nudge, not evidence. All it is believed for is *which athlete*; the
 * pairing to an event of ours is asked for over the API as usual, so a replayed or
 * forged body cannot tick a session off by itself. Every connection to that athlete
 * is visited, because more than one of ours can legitimately point at the same one.
 */
export async function onAccountActivity(
  env: Env,
  platformId: PlatformId,
  accountId: string,
): Promise<{ matched: number; marked: number }> {
  const connections = await store.connectionsForAccount(env, platformId, accountId);
  let marked = 0;
  let failure: unknown;

  for (const connection of connections) {
    if (!connection.token) continue;
    try {
      marked += await applyCompletions(env, connection.user_id, platformId, connection.token);
    } catch (err) {
      // Recorded per athlete and kept, not thrown: one athlete's revoked token must
      // not cost the others their completions. Re-raised once they have all had a go.
      await store.recordSyncError(env, connection.user_id, platformId, message(err));
      failure ??= err;
    }
  }

  if (failure) throw failure;
  return { matched: connections.length, marked };
}

/** Athletes per scheduled pass; the next one carries on. See `store.connectionBatch`. */
export const PULL_BATCH = 40;

/** The hourly pass. Errors are per-athlete, and every connection visited is stamped. */
export async function pullEveryCompletion(env: Env): Promise<number> {
  let marked = 0;
  for (const platformId of Object.keys(PLATFORMS) as PlatformId[]) {
    for (const connection of await store.connectionBatch(env, platformId, PULL_BATCH)) {
      if (!connection.token) {
        await store.recordSyncError(
          env,
          connection.user_id,
          platformId,
          'the stored token could not be read back; connect the platform again',
        );
        continue;
      }
      try {
        marked += await applyCompletions(env, connection.user_id, platformId, connection.token);
      } catch (err) {
        await store.recordSyncError(env, connection.user_id, platformId, message(err));
      }
    }
  }
  return marked;
}

/** Drop links to workouts gone for good. Outside the window only; inside, `syncNow` has them. */
export const pruneOrphanedLinks = store.pruneOrphanedLinks;

// --- Recorded sessions, for anything that wants the file itself ---------------

/** One platform's recorded sessions, token already in hand. What `src/drive/` is handed. */
export type ActivitySource = {
  platform: PlatformId;
  /** Names the folder a copy lands in, so the destination never learns a platform id. */
  label: string;
  activities(from: string, to: string): Promise<Recorded[]>;
  recording(recorded: Recorded): Promise<RecordedFile>;
};

/** Only platforms that offer them, and only where the athlete's token still reads back. */
export async function activitySources(env: Env, userId: string): Promise<ActivitySource[]> {
  const sources: ActivitySource[] = [];
  for (const { platform: platformId, token } of await store.usableConnections(env, userId)) {
    const platform = PLATFORMS[platformId] as Platform | undefined;
    if (!platform?.activities || !platform.recording) continue;
    sources.push({
      platform: platformId,
      label: platform.label,
      activities: platform.activities.bind(platform, token),
      recording: platform.recording.bind(platform, token),
    });
  }
  return sources;
}
