/**
 * Keeping the athlete's plan in step with the platforms they have connected.
 *
 * Every write to a workout goes through `src/plan.ts`, and `src/plan.ts` calls
 * in here, so there is one place that decides what a create, an update, a move
 * or a delete means to a platform — and adding a second platform is a new file
 * in this directory and a line in `PLATFORMS`, not another call site.
 *
 * Two rules shape the whole module:
 *
 *  - A platform never fails an athlete's own write. intervals.icu being down,
 *    or a key having been revoked, must not turn creating a workout into a
 *    500. Failures are caught, recorded against the connection, and shown on
 *    the dashboard; the next write or a "Sync now" retries.
 *  - Completions coming back in are written straight to the database rather
 *    than back through `plan.ts`, so marking a session done here cannot echo
 *    out to the platform it just came from.
 */

import { sha256 } from '../auth';
import * as db from '../db';
import type { Env, User } from '../db';
import type { Workout } from '../workout';
import { intervals } from './intervals';
import * as store from './store';
import type { Account, Completion, Platform, PlatformId } from './types';
import { PlatformError } from './types';

export { CredentialsUnavailable, credentialsConfigured } from './store';
export type { Connection } from './store';
export { PlatformError } from './types';
export type { PlatformId } from './types';

export const PLATFORMS: Record<PlatformId, Platform> = { intervals };

export const isPlatformId = (value: string): value is PlatformId =>
  Object.prototype.hasOwnProperty.call(PLATFORMS, value);

/**
 * How many workouts one sync run may push.
 *
 * A Worker is capped on outbound subrequests per invocation, and the per-user
 * workout cap is above that cap, so a first sync of a full calendar is done
 * over more than one run rather than dying half way through the last one.
 * Only stale workouts are pushed, so each run makes progress.
 */
export const PUSH_LIMIT = 40;

/**
 * Our stable handle on a workout, used as the upsert key upstream.
 *
 * It has to survive the workout being edited, moved to another day, and the
 * link row being swept, which is why it is built from ids rather than from
 * the date or anything else the athlete can change.
 */
const syncKey = (userId: string, workout: Pick<Workout, 'id'>): string => `workout-mcp-${userId}-${workout.id}`;

/**
 * A digest of everything a push actually carries.
 *
 * Compared against the link to decide whether a workout needs pushing again.
 * `updated_at` cannot do that job: recording a completion read back off a
 * platform bumps it, and the next sync would then push the unchanged plan
 * straight back out over a change that platform itself reported.
 */
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

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

/** Check the credential works before storing it, so a typo fails here and now. */
export async function connect(env: Env, user: User, platformId: PlatformId, key: string): Promise<Account> {
  // Asked before the platform is, so a Worker with nowhere to put the key
  // does not send it off to be verified and then refuse to keep it.
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
        connected: connection !== undefined,
        account: connection?.account ?? null,
        last_error: connection?.last_error ?? null,
        synced: connection ? await store.countLinks(env, user.id, platform.id) : 0,
        updated_at: connection?.updated_at ?? null,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Pushing
// ---------------------------------------------------------------------------

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

/**
 * A workout was created or replaced.
 *
 * `previous` is where it used to live when the write moved it, so the link
 * follows the workout rather than being left pointing at a row that is gone —
 * which would push a second copy upstream and orphan the first.
 */
export async function onWorkoutSaved(
  env: Env,
  user: User,
  workout: Workout,
  previous?: { date: string; id: string },
): Promise<void> {
  if (previous && (previous.date !== workout.date || previous.id !== workout.id)) {
    await store.moveLinks(env, user.id, previous, { date: workout.date, id: workout.id });
  }

  for (const { platform: platformId, key } of await store.usableConnections(env, user.id)) {
    const platform = PLATFORMS[platformId];
    if (!platform) continue;
    try {
      await pushOne(env, user.id, platform, key, workout);
      await store.recordSyncError(env, user.id, platformId, null);
    } catch (err) {
      await store.recordSyncError(env, user.id, platformId, `“${workout.name}” on ${workout.date}: ${message(err)}`);
    }
  }
}

/** A workout was deleted here, so it should go from the platforms too. */
export async function onWorkoutDeleted(env: Env, user: User, date: string, id: string): Promise<void> {
  for (const { platform: platformId, key } of await store.usableConnections(env, user.id)) {
    const platform = PLATFORMS[platformId];
    if (!platform) continue;

    const link = await store.findLink(env, user.id, platformId, date, id);
    if (!link) continue;
    try {
      await platform.remove(key, link.remote_id);
      await store.dropLink(env, user.id, platformId, date, id);
      await store.recordSyncError(env, user.id, platformId, null);
    } catch (err) {
      // The link stays, so the next delete or sync can try again rather than
      // leaving a session on the calendar nothing here remembers pushing.
      await store.recordSyncError(env, user.id, platformId, `deleting ${date}/${id}: ${message(err)}`);
    }
  }
}

export type SyncReport = { platform: PlatformId; pushed: number; remaining: number; completed: number; error: string | null };

/**
 * Push whatever is out of date, then read completions back.
 *
 * "Out of date" is a workout with no link, or one changed since its link was
 * written — so a run over an already-synced calendar costs one list and no
 * pushes, and a run that hits the cap leaves the rest for the next one.
 */
export async function syncNow(env: Env, user: User, platformId: PlatformId): Promise<SyncReport> {
  const report: SyncReport = { platform: platformId, pushed: 0, remaining: 0, completed: 0, error: null };

  const key = await store.credentialFor(env, user.id, platformId);
  if (!key) {
    report.error = 'no usable credential for this platform; connect it again';
    return report;
  }
  const platform = PLATFORMS[platformId];

  try {
    const workouts = await db.listWorkouts(env, user.id);
    const links = await store.listLinks(env, user.id, platformId);
    const stale: Workout[] = [];
    for (const workout of workouts) {
      const link = links.get(`${workout.date}/${workout.id}`);
      if (!link || link.fingerprint !== (await fingerprint(workout))) stale.push(workout);
    }

    for (const workout of stale.slice(0, PUSH_LIMIT)) {
      await pushOne(env, user.id, platform, key, workout);
      report.pushed += 1;
    }
    report.remaining = Math.max(0, stale.length - report.pushed);

    report.completed = await applyCompletions(env, user.id, platformId, key);
    await store.recordSyncError(env, user.id, platformId, null);
  } catch (err) {
    report.error = message(err);
    await store.recordSyncError(env, user.id, platformId, report.error);
  }
  return report;
}

// ---------------------------------------------------------------------------
// Completions coming back
// ---------------------------------------------------------------------------

/**
 * Mark done whatever the platform says was actually done.
 *
 * intervals.icu pairs a recorded activity with the planned event it matches,
 * and that pairing is the completion. It is polled rather than pushed:
 * intervals.icu delivers webhooks only to OAuth applications it has approved,
 * and this integration is a key the athlete pastes in, so there is no callback
 * to register. The poll runs on the nightly sweep and on "Sync now".
 *
 * Writes go straight to the database: a completion that came from a platform
 * must not be pushed back out to it.
 */
async function applyCompletions(env: Env, userId: string, platformId: PlatformId, key: string): Promise<number> {
  const window = db.readWindow();
  const completions: Completion[] = await PLATFORMS[platformId].completions(key, window.from, window.to);

  let marked = 0;
  for (const completion of completions) {
    const link = await store.findLinkByRemoteId(env, userId, platformId, completion.remote_id);
    if (!link) continue;

    const workout = await db.getWorkout(env, userId, link.date, link.workout_id);
    // Already recorded at that instant: rewriting it would only churn
    // `updated_at`, which is what the next sync reads to decide what is stale.
    if (!workout || workout.completed_at === completion.completed_at) continue;

    await db.setCompleted(env, userId, link.date, link.workout_id, completion.completed_at);
    marked += 1;
  }
  return marked;
}

/**
 * How many athletes one scheduled pass reads completions for.
 *
 * A scheduled run has the same subrequest budget as any other invocation, so
 * the sweep takes the least recently visited batch and the next run carries
 * on from there. See `store.connectionBatch`.
 */
export const PULL_BATCH = 40;

/**
 * The scheduled pass over the athletes who have connected a platform.
 *
 * Errors are per-athlete: one revoked key must not stop the sweep for anyone
 * else, so each is recorded against its own connection and the loop goes on.
 */
export async function pullEveryCompletion(env: Env): Promise<number> {
  let marked = 0;
  for (const platformId of Object.keys(PLATFORMS) as PlatformId[]) {
    for (const connection of await store.connectionBatch(env, platformId, PULL_BATCH)) {
      const key = await store.decryptSecret(env, connection.secret).catch(() => null);
      if (!key) continue;
      try {
        marked += await applyCompletions(env, connection.user_id, platformId, key);
        await store.recordSyncError(env, connection.user_id, platformId, null);
      } catch (err) {
        await store.recordSyncError(env, connection.user_id, platformId, message(err));
      }
    }
  }
  return marked;
}

export const pruneOrphanedLinks = store.pruneOrphanedLinks;
