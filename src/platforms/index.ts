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
 * Everything a change to a workout does to the platforms, with nothing able
 * to escape and fail the athlete's own write.
 *
 * The bookkeeping is inside the guard, not only the push: a link table that
 * refuses a write is still no reason for a workout that is safely stored to
 * come back as a 500.
 */
async function sideEffect(what: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error(`platform sync failed while ${what}`, err);
  }
}

/**
 * A workout was created or replaced.
 *
 * `previous` is where it used to live when the write moved it, so the link
 * follows the workout rather than being left pointing at a row that is gone —
 * which would push a second copy upstream and orphan the first.
 *
 * A failure is recorded against the connection and left there: it is cleared
 * by a sync that finds nothing left to do, not by the next workout happening
 * to push cleanly, because that one says nothing about this one.
 */
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
        // The link stays, so the nightly retry or the next sync can try again
        // rather than leaving a session on a calendar nothing here remembers.
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

/**
 * Bring a platform back into step, and read completions back.
 *
 * Out of step is three things: a workout with no link or one whose plan has
 * changed since it was last pushed, and a link that names no workout — a
 * delete that did not reach the platform. A run over a calendar that is
 * already in step costs one list and no pushes.
 *
 * This is also the only thing that clears the connection's standing error: a
 * single workout pushing cleanly says nothing about the one that did not, so
 * only a run that finds nothing left to do may call the connection well.
 */
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

    // A link naming no workout, whose date is still inside the window, is a
    // delete that never landed. Outside the window there is nothing useful to
    // do: the date is past reading, and taking a session off an athlete's own
    // calendar on the strength of a row we can no longer check is worse than
    // leaving it. `pruneOrphanedLinks` clears those away instead.
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
    // Only now, and only if the cap left nothing behind: a connection with
    // work still queued is not yet in step.
    await store.recordSyncError(env, user.id, platformId, report.remaining > 0 ? `${report.remaining} left to sync` : null);
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
 *
 * Each completion is applied exactly once, remembered on the link. An athlete
 * who un-ticks a session means it, and without that memory the next pass
 * would find the platform still reporting the activity and tick it back on,
 * making the uncomplete button useless on anything synced.
 */
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

/**
 * How many athletes one scheduled pass touches.
 *
 * A scheduled run has the same subrequest budget as any other invocation, so
 * each pass takes a batch and the next one carries on from where it left off.
 * See `store.connectionBatch`.
 */
export const PULL_BATCH = 40;

/** How many stuck connections the nightly retry takes on. */
export const RETRY_BATCH = 10;

/**
 * The hourly pass: read completions back off the connected platforms.
 *
 * Errors are per-athlete: one revoked key must not stop the sweep for anyone
 * else, so each is recorded against its own connection and the loop goes on.
 * Every connection visited is stamped, readable or not, because the batch is
 * ordered by when it was last visited — skipping one silently would park the
 * batch on it and quietly stop the sweep for everybody behind it.
 */
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

/**
 * The nightly retry of connections carrying a standing error.
 *
 * Nothing else picks these up: a push that failed is not retried by the next
 * workout written, since that one pushes only itself. Without this, a session
 * missing from a calendar because the platform was down for a minute stays
 * missing until an athlete notices and presses Sync now.
 */
export async function retryFailedConnections(env: Env): Promise<number> {
  let fixed = 0;
  for (const connection of await store.failedConnections(env, RETRY_BATCH)) {
    if (!isPlatformId(connection.platform)) continue;
    const report = await syncNow(env, { id: connection.user_id, email: null }, connection.platform);
    if (!report.error) fixed += 1;
  }
  return fixed;
}

/**
 * Drop links to workouts that are gone for good.
 *
 * Only outside the window we keep: inside it, a link with no workout is a
 * delete that has yet to reach the platform, which `syncNow` flushes. Outside
 * it, the workout was swept by retention and the session stays on the
 * athlete's calendar, so the link has nothing left to name.
 */
export const pruneOrphanedLinks = store.pruneOrphanedLinks;
