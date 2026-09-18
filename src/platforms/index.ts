// Keeping the athlete's plan in step with their connected platforms. See docs/integrations.md.

import { sha256 } from '../auth';
import * as db from '../db';
import type { Env, User } from '../db';
import { intervalsConfigured } from '../identity';
import { MAX_RECORDING_BYTES, statsFrom, statsUnreadable } from '../stats';
import type { StatsSummary } from '../stats';
import type { Workout } from '../workout';
import { intervals } from './intervals';
import * as store from './store';
import type { Account, Completion, Platform, PlatformId, Recorded, RecordedFile, Recording } from './types';
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

/** The upsert key upstream: the workout's own id, so an edit or a move cannot change it. */
const syncKey = (workout: Pick<Workout, 'id'>): string => workout.id;

// Decides what is stale. Not `updated_at`: a completion read back off a platform bumps that.
const fingerprint = (workout: Workout): Promise<string> =>
  sha256(
    JSON.stringify([
      workout.date,
      workout.name,
      workout.sport,
      workout.sub_sport ?? null,
      workout.notes ?? null,
      workout.tags ?? null,
      workout.steps,
    ]),
  );

const message = (err: unknown): string =>
  err instanceof PlatformError || err instanceof Error ? err.message : String(err);

// Whether they turned this down themselves: a refusal they gave will be given again.
// A 5xx, a 429 and a call that never reached them are all worth another pass.
const answered = (err: unknown): boolean =>
  err instanceof PlatformError && err.status !== null && err.status < 500 && err.status !== 429;

// --- Connecting ------------------------------------------------------------

/** Store the token an OAuth round came back with. Refused with nowhere safe to put it. */
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

  // Not where another account here shares the athlete: upstream releases the app, not
  // one token of it, so handing it back would take their connection down with ours.
  const shared = await store.accountSharedWithOthers(env, user.id, platformId);

  if (platform?.revoke && token && !shared) {
    // Never fails the disconnect: they can still revoke it from their own settings.
    await platform.revoke(token).catch((err: unknown) => {
      console.error(`releasing the ${platformId} credential failed`, err);
    });
  }
  return store.forgetConnection(env, user.id, platformId);
}

export type PlatformStatus = {
  id: PlatformId;
  label: string;
  connect_help: string;
  connected_note: string | null;
  connected: boolean;
  account: string | null;
  /** Whether this deployment was given the platform's OAuth client at all. */
  oauth: boolean;
  last_error: string | null;
  synced: number;
  updated_at: string | null;
};

// Here rather than on the adapter: whether this deployment was given the platform's
// OAuth client is not the adapter's business.
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
        connect_help: platform.connect_help,
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
  const remoteId = await platform.push(token, { workout, syncKey: syncKey(workout) });
  await store.saveLink(env, userId, platform.id, workout.date, workout.id, remoteId, await fingerprint(workout));
}

/** Nothing in here may fail the athlete's own write — the bookkeeping included. */
async function sideEffect(what: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    // Their own complaint goes in the line itself: a stack says where we gave up and
    // nothing about what they actually said.
    console.error(`platform sync failed while ${what}: ${message(err)}`, err);
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

/**
 * A comment written here goes up onto the session, but only once the recording has come
 * back: the stats name the activity, the only handle on the session upstream. Written
 * earlier it waits, and `applyCompletions` carries it up with the completion.
 */
export async function onCommentSaved(env: Env, user: User, workout: Workout): Promise<void> {
  await sideEffect(`commenting on ${workout.date}/${workout.id}`, async () => {
    for (const { platform: platformId, token } of await store.usableConnections(env, user.id)) {
      const platform = PLATFORMS[platformId] as Platform | undefined;
      if (!platform?.setActivityComment) continue;

      const activityId = workout.stats?.platform === platformId ? workout.stats.activity_id : null;
      if (!activityId) continue;

      try {
        await platform.setActivityComment(token, activityId, workout.comment ?? null);
      } catch (err) {
        await store.recordSyncError(
          env,
          user.id,
          platformId,
          `commenting on ${workout.date}/${workout.id}: ${message(err)}`,
        );
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

    // No stats budget: a person is waiting on this one, and a recording is a download
    // and a FIT decode. The webhook and the hourly pass read them instead.
    report.completed = await applyCompletions(env, user.id, platformId, token, { left: 0 });
    // The only place a standing error is cleared, and only with nothing left queued.
    await store.recordSyncError(env, user.id, platformId, report.remaining > 0 ? `${report.remaining} left to sync` : null);
  } catch (err) {
    report.error = message(err);
    await store.recordSyncError(env, user.id, platformId, report.error);
  }
  return report;
}

// --- Completions coming back -----------------------------------------------

/**
 * Recordings read per run, across every athlete in it — not a per-athlete allowance,
 * which the hourly pass would multiply by its batch of forty. A backlog is worked off
 * over the passes behind it.
 */
export const STATS_LIMIT = 5;

/** Tries at one recording before its failure stands. */
export const STATS_ATTEMPTS = 3;

/** And how long one is left alone between those tries, so an outage costs one of them. */
export const STATS_RETRY_AFTER_MS = 30 * 60 * 1000;

/** What is left of `STATS_LIMIT`, shared by every athlete the invocation visits. */
type Budget = { left: number };

/**
 * One already read is left alone unless the platform now names a *different* activity —
 * an upload deleted and done again. One that could not be read is tried again, but never
 * twice inside half an hour, so an outage costs one attempt rather than all three.
 */
export function worthReading(
  stats: StatsSummary | undefined,
  activityId: string,
  now: number = Date.now(),
): boolean {
  if (!stats) return true;
  if (stats.activity_id !== activityId) return true;
  if (!stats.flags.includes('source_unreadable')) return false;

  const tried = Date.parse(stats.computed_at);
  return (
    (stats.attempts ?? 1) < STATS_ATTEMPTS && !Number.isNaN(tried) && now - tried > STATS_RETRY_AFTER_MS
  );
}

// Capped on what actually arrives: `content_length` is the platform's word and often
// absent, and a Worker has 128 MB and no second chance at an OOM.
async function bytesOf(file: RecordedFile, limit: number): Promise<Uint8Array> {
  const reader = (file.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new Error(`the recording is over ${limit} bytes, past what is read here`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/**
 * An unreadable recording is stored as *saying* so, with the attempt it was: otherwise
 * the hourly pass fetches a session with no file to fetch — a manual entry, or one from
 * Strava — every hour forever.
 */
async function readStats(
  env: Env,
  userId: string,
  platform: Platform,
  token: string,
  workout: Workout,
  activity: Recording,
): Promise<void> {
  const source = { platform: platform.id, activity_id: activity.remote_id };
  const attempt = (workout.stats?.attempts ?? 0) + 1;

  let stats;
  try {
    const file = await platform.recording!(token, activity);
    stats = statsFrom(await bytesOf(file, MAX_RECORDING_BYTES), workout, source);
  } catch (err) {
    stats = statsUnreadable(source, message(err), attempt);
  }
  await db.setStats(env, userId, workout.id, stats);
}

/**
 * Outbound only, deliberately: `comment` is the athlete's own words, and the description
 * upstream is not reliably theirs — a recording app writes its own line into it on
 * upload. See "The comment goes out, and never comes back" in docs/integrations.md.
 *
 * A workout with no comment leaves their description alone; clearing travels by its own
 * path, `onCommentSaved`. Agreement costs nothing, since the comparison is off the
 * completion listing fetched anyway. `applied_comment` is what stops a refusal being
 * retried every pass, the way `applied_completion` does for the other.
 */
async function syncComment(
  env: Env,
  userId: string,
  platform: Platform,
  token: string,
  link: store.Link,
  workout: Workout,
  completion: Completion,
): Promise<void> {
  const here = workout.comment ?? null;
  if (here === null || here === completion.comment) return;

  if (!platform.setActivityComment || !completion.activity) return;
  // Already handed over and still not showing upstream: they will not take this one.
  if (link.applied_comment === here) return;

  const remember = (): Promise<void> =>
    store.recordAppliedComment(env, userId, platform.id, link.date, link.workout_id, here);

  try {
    await platform.setActivityComment(token, completion.activity.remote_id, here);
  } catch (err) {
    await store.recordSyncError(
      env,
      userId,
      platform.id,
      `commenting on ${link.date}/${link.workout_id}: ${message(err)}`,
    );
    // Only what they answered is settled. A platform we never reached gets another pass.
    if (answered(err)) await remember();
    throw err;
  }
  await remember();
}

// Straight to the db, and once each: see "Completion is polled" in docs/integrations.md.
async function applyCompletions(
  env: Env,
  userId: string,
  platformId: PlatformId,
  token: string,
  budget: Budget = { left: STATS_LIMIT },
): Promise<number> {
  const window = db.readWindow();
  const platform = PLATFORMS[platformId];
  const completions: Completion[] = await platform.completions(token, window.from, window.to);

  let marked = 0;
  for (const completion of completions) {
    const link = await store.findLinkByRemoteId(env, userId, platformId, completion.remote_id);
    if (!link) continue;
    const workout = await db.getWorkout(env, userId, link.workout_id);
    if (!workout) continue;

    if (link.applied_completion !== completion.completed_at) {
      await db.setCompleted(env, userId, link.workout_id, completion.completed_at);
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

    // The stored stats are what says this was read already: a session whose plan was
    // rewritten, or which arrived before this existed, is picked up by the next pass.
    if (
      budget.left > 0 &&
      completion.activity &&
      platform.recording &&
      worthReading(workout.stats, completion.activity.remote_id)
    ) {
      budget.left -= 1;
      // Never fails the completion: a recording we could not read is not a session undone.
      await sideEffect(`reading the stats for ${link.date}/${link.workout_id}`, () =>
        readStats(env, userId, platform, token, workout, completion.activity!),
      );
    }

    // Never at the cost of the completion either: a note that would not sync is
    // still a session that happened.
    await sideEffect(`syncing the comment on ${link.date}/${link.workout_id}`, () =>
      syncComment(env, userId, platform, token, link, workout, completion),
    );
  }
  return marked;
}

/**
 * The event is a nudge, not evidence: all it is believed for is *which athlete*, and the
 * pairing is read back over the API as usual. Every connection to that athlete is
 * visited, because more than one of ours can legitimately point at the same one.
 */
export async function onAccountActivity(
  env: Env,
  platformId: PlatformId,
  accountId: string,
): Promise<{ matched: number; marked: number }> {
  const connections = await store.connectionsForAccount(env, platformId, accountId);
  const budget: Budget = { left: STATS_LIMIT };
  let marked = 0;
  let failure: unknown;

  for (const connection of connections) {
    if (!connection.token) {
      // Said out loud: otherwise a rotated `CREDENTIALS_SECRET` is a connection that
      // quietly stops hearing anything.
      await store.recordSyncError(
        env,
        connection.user_id,
        platformId,
        'the stored token could not be read back; connect the platform again',
      );
      continue;
    }
    try {
      marked += await applyCompletions(env, connection.user_id, platformId, connection.token, budget);
    } catch (err) {
      // Per athlete: one revoked token must not cost the others their completions.
      // Re-raised once they have all had a go.
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
  const budget: Budget = { left: STATS_LIMIT };
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
        marked += await applyCompletions(env, connection.user_id, platformId, connection.token, budget);
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
