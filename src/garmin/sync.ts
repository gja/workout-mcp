/**
 * Pushing planned workouts to the athlete's Garmin Connect calendar.
 *
 * The sync is a diff, not a re-upload. Every workout that has been pushed
 * before has a row in `garmin_workouts` naming the Garmin workout it became,
 * the calendar entry that put it on a date, and a fingerprint of the payload
 * that was sent. A run compares that against what is stored locally now and
 * does the smallest thing that reconciles the two:
 *
 *   new locally           create the workout, then schedule it
 *   changed               update the workout in place
 *   moved to another day  update it, then replace the calendar entry
 *   unchanged             nothing at all, and no Garmin call
 *   deleted locally       remove the calendar entry and the workout
 *   gone from Garmin      drop the stale link and put the session back
 *
 * Which makes it safe to run as often as you like: the same plan synced twice
 * costs nothing and changes nothing.
 *
 * The one case worth stating outright is the last. A workout can leave this
 * server two ways — the athlete deleted it, or it aged out of the retention
 * window — and those want opposite treatment. A deleted session should
 * disappear from the calendar; a session that has simply scrolled off the
 * back of a 7-day window is *training the athlete has done*, and deleting
 * that from their Garmin history because our retention is short would be
 * indefensible. So a link whose date is still inside the window and has no
 * workout was deleted, and is removed from Garmin; one whose date has fallen
 * outside it is left alone on Garmin and merely stops being tracked here.
 */

import * as db from '../db';
import type { Env } from '../db';
import type { Workout } from '../workout';
import { fingerprint } from './crypto';
import { GarminApiError, createWorkout, deleteWorkout, scheduleWorkout, unscheduleWorkout, updateWorkout } from './api';
import { buildWorkout } from './payload';
import type { GarminWorkout } from './payload';
import { GarminAuthError, isConfigured } from './oauth';
import * as store from './store';
import type { Connection, Link } from './store';

/**
 * The most Garmin calls one run may make.
 *
 * A Worker gets a bounded number of outbound subrequests per invocation — 50
 * on the free plan this app is built to fit — and a workout costs up to four
 * of them. So a run does what it can within budget and says how much is left,
 * rather than dying partway through with no report. Nothing is lost: the next
 * run picks up exactly where this one stopped, because the diff is computed
 * from stored state rather than from where a cursor got to.
 */
export const MAX_CALLS_PER_RUN = 30;

/** How many athletes the nightly sweep pushes for, for the same reason. */
export const MAX_USERS_PER_SWEEP = 5;

export type SyncAction =
  | 'created'
  | 'updated'
  | 'rescheduled'
  | 'unchanged'
  | 'removed'
  | 'untracked'
  | 'skipped'
  | 'failed';

export type SyncEntry = {
  date: string;
  id: string;
  name?: string;
  action: SyncAction;
  garmin_workout_id?: string;
  garmin_schedule_id?: string;
  /** What the Training API could not carry. See `payload.ts`. */
  notes?: string[];
  error?: string;
  /** On a dry run, exactly what would have been sent. */
  payload?: GarminWorkout;
};

export type SyncReport = {
  dry_run: boolean;
  /** Set when the call budget ran out; run again to finish. */
  truncated: boolean;
  counts: Record<SyncAction, number>;
  workouts: SyncEntry[];
  /** A failure that stopped the run rather than one workout. */
  error?: string;
};

const emptyCounts = (): Record<SyncAction, number> => ({
  created: 0,
  updated: 0,
  rescheduled: 0,
  unchanged: 0,
  removed: 0,
  untracked: 0,
  skipped: 0,
  failed: 0,
});

/**
 * A failure that makes the rest of the run pointless.
 *
 * A refused payload is one workout's problem; an expired token or a rate
 * limit is every workout's, and grinding through forty more of them only
 * turns one clear error into forty confusing ones.
 */
const isFatal = (error: unknown): boolean =>
  error instanceof GarminAuthError ||
  (error instanceof GarminApiError && (error.status === 401 || error.status === 403 || error.status === 429));

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'an unexpected error while syncing';

// ---------------------------------------------------------------------------
// One workout
// ---------------------------------------------------------------------------

/** Tracks the call budget, so every path spends from the same purse. */
type Budget = { remaining: number };

/**
 * What the diff decided to do with one workout, before any of it is done.
 *
 * Naming this rather than branching inside the push keeps the decision — the
 * part worth testing without a network — apart from the calls that carry it
 * out.
 */
type Plan =
  | { do: 'nothing' }
  | { do: 'create' }
  | { do: 'update'; link: Link }
  /** The workout is right on Garmin, but it is on the wrong day or on no day. */
  | { do: 'reschedule'; link: Link }
  | { do: 'update-and-reschedule'; link: Link };

export function planFor(workout: Workout, link: Link | undefined, current: string, force: boolean): Plan {
  if (!link) return { do: 'create' };

  const contentStale = force || link.fingerprint !== current;
  // A link with no calendar entry is one whose scheduling failed after the
  // workout itself was created. Always work to be done, and specifically not
  // work that starts by creating a second copy of the workout.
  const dateStale = link.garminScheduleId === null || link.scheduledDate !== workout.date;

  if (contentStale && dateStale) return { do: 'update-and-reschedule', link };
  if (contentStale) return { do: 'update', link };
  if (dateStale) return { do: 'reschedule', link };
  return { do: 'nothing' };
}

/**
 * Move the calendar entry to the workout's date.
 *
 * The old entry goes first. Garmin will happily hold two entries for the same
 * workout on two days, and an athlete who moved a session from Tuesday to
 * Thursday would then find it on both.
 */
async function reschedule(
  token: string,
  link: Link,
  date: string,
  budget: Budget,
): Promise<{ scheduleId: string }> {
  if (link.garminScheduleId) {
    budget.remaining--;
    await unscheduleWorkout(token, link.garminScheduleId);
  }
  budget.remaining--;
  return { scheduleId: await scheduleWorkout(token, link.garminWorkoutId, date) };
}

/**
 * Carry out a plan, and return the link to store for it.
 *
 * `env` and `userId` are here for one reason: the moment a workout has been
 * created on Garmin, that fact has to be written down even if the call that
 * follows it fails. Everything else is persisted by the caller, from the
 * value returned.
 */
async function apply(
  env: Env,
  userId: string,
  token: string,
  workout: Workout,
  payload: GarminWorkout,
  current: string,
  plan: Exclude<Plan, { do: 'nothing' }>,
  budget: Budget,
): Promise<{ action: SyncAction; link: Omit<Link, 'syncedAt'> }> {
  if (plan.do === 'create') {
    budget.remaining--;
    const garminWorkoutId = await createWorkout(token, payload);

    // From here on the workout exists on Garmin, so the link is stored before
    // the scheduling is attempted — otherwise a failure there would leave the
    // next run creating a second copy of a workout that is already up. A link
    // with a null schedule id is what `planFor` reads as "created, still
    // needs a calendar entry", so the retry does the one call it should.
    await store.saveLink(env, userId, {
      workoutId: workout.id,
      garminWorkoutId,
      garminScheduleId: null,
      scheduledDate: workout.date,
      fingerprint: current,
    });

    budget.remaining--;
    const garminScheduleId = await scheduleWorkout(token, garminWorkoutId, workout.date);
    return {
      action: 'created',
      link: {
        workoutId: workout.id,
        garminWorkoutId,
        garminScheduleId,
        scheduledDate: workout.date,
        fingerprint: current,
      },
    };
  }

  const { link } = plan;

  if (plan.do === 'reschedule') {
    const { scheduleId } = await reschedule(token, link, workout.date, budget);
    return {
      action: 'rescheduled',
      link: { ...link, garminScheduleId: scheduleId, scheduledDate: workout.date },
    };
  }

  budget.remaining--;
  try {
    await updateWorkout(token, link.garminWorkoutId, payload);
  } catch (error) {
    // The athlete deleted it in the Connect app. Our link names a workout
    // that is not there any more, and every future run would fail on the same
    // id until they disconnected — so the link is dropped and the session is
    // put back as a new one, which is what they would have to do by hand.
    if (!(error instanceof GarminApiError) || error.status !== 404) throw error;

    // The calendar entry very likely went with it, but "very likely" is not
    // something to leave an athlete looking at an entry that points nowhere.
    // `unscheduleWorkout` treats an already-gone entry as success, so the
    // cost of being sure is one wasted call in a path this rare.
    if (link.garminScheduleId) {
      budget.remaining--;
      await unscheduleWorkout(token, link.garminScheduleId);
    }
    await store.deleteLink(env, userId, workout.id);
    return apply(env, userId, token, workout, payload, current, { do: 'create' }, budget);
  }

  if (plan.do === 'update') {
    return { action: 'updated', link: { ...link, fingerprint: current } };
  }

  const { scheduleId } = await reschedule(token, link, workout.date, budget);
  return {
    action: 'rescheduled',
    link: { ...link, garminScheduleId: scheduleId, scheduledDate: workout.date, fingerprint: current },
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export type SyncOptions = {
  /** Build and diff everything, call nothing, and show what would be sent. */
  dryRun?: boolean;
  /** Push every workout again even where the fingerprint says nothing changed. */
  force?: boolean;
};

/**
 * Reconcile the athlete's whole retention window with their Garmin calendar.
 *
 * Throws only when the run could not start — no connection, or a token that
 * cannot be refreshed. Anything that goes wrong once it has started is in the
 * report, so a single refused workout does not hide the thirty that worked.
 */
export async function syncAll(env: Env, userId: string, options: SyncOptions = {}): Promise<SyncReport> {
  const dryRun = options.dryRun === true;
  const force = options.force === true;

  if (!isConfigured(env)) throw new GarminAuthError('Garmin sync is not configured on this server');

  const stored = await store.getConnection(env, userId);
  if (!stored) {
    throw new GarminAuthError('no Garmin account is connected — connect one from the dashboard first');
  }

  // A dry run touches Garmin not at all, so it deliberately does not refresh:
  // it should still be able to show what would be sent when the token has
  // lapsed, which is exactly when someone wants to look.
  const connection: Connection = dryRun ? stored : await store.withFreshToken(env, stored);

  const report: SyncReport = { dry_run: dryRun, truncated: false, counts: emptyCounts(), workouts: [] };
  const record = (entry: SyncEntry): void => {
    report.counts[entry.action]++;
    report.workouts.push(entry);
  };

  const workouts = await db.listWorkouts(env, userId);
  const links = await store.listLinks(env, userId);
  const byWorkoutId = new Map(links.map((link) => [link.workoutId, link]));
  const seen = new Set<string>();

  const budget: Budget = { remaining: dryRun ? Number.POSITIVE_INFINITY : MAX_CALLS_PER_RUN };
  let fatal: string | undefined;

  for (const workout of workouts) {
    seen.add(workout.id);
    const link = byWorkoutId.get(workout.id);
    const base = { date: workout.date, id: workout.id, name: workout.name };

    if (fatal) {
      record({ ...base, action: 'skipped' });
      continue;
    }

    const built = buildWorkout(workout);
    const current = await fingerprint(built.workout);
    const plan = planFor(workout, link, current, force);
    const notes = built.notes.length > 0 ? { notes: built.notes } : {};

    if (plan.do === 'nothing') {
      record({ ...base, action: 'unchanged', garmin_workout_id: link?.garminWorkoutId, ...notes });
      continue;
    }

    if (dryRun) {
      record({
        ...base,
        // A dry run says what the plan is by naming the action it would take.
        action: plan.do === 'create' ? 'created' : plan.do === 'update' ? 'updated' : 'rescheduled',
        garmin_workout_id: link?.garminWorkoutId,
        payload: built.workout,
        ...notes,
      });
      continue;
    }

    // Four calls is the most a single workout can cost — an update that turns
    // out to be gone, then clearing its entry, then creating and scheduling
    // it again. Stopping while that much is left means no workout is ever
    // half-applied for want of budget, only for want of Garmin's cooperation.
    if (budget.remaining < 4) {
      report.truncated = true;
      record({ ...base, action: 'skipped' });
      continue;
    }

    try {
      const { action, link: updated } = await apply(
        env,
        userId,
        connection.accessToken,
        workout,
        built.workout,
        current,
        plan,
        budget,
      );
      await store.saveLink(env, userId, updated);
      record({
        ...base,
        action,
        garmin_workout_id: updated.garminWorkoutId,
        ...(updated.garminScheduleId ? { garmin_schedule_id: updated.garminScheduleId } : {}),
        ...notes,
      });
    } catch (error) {
      const message = errorMessage(error);
      record({ ...base, action: 'failed', error: message, ...notes });
      if (isFatal(error)) fatal = message;
    }
  }

  // Anything we have a link for that is no longer here. See the note at the
  // top of the file for why the two cases below are not the same case.
  const window = db.retentionWindow();
  for (const link of links) {
    if (seen.has(link.workoutId)) continue;
    const base = { date: link.scheduledDate, id: link.workoutId };

    const agedOut = link.scheduledDate < window.from || link.scheduledDate > window.to;
    if (agedOut) {
      // Training the athlete has already done. It stays on their calendar;
      // we just stop claiming to know about it.
      if (!dryRun) await store.deleteLink(env, userId, link.workoutId);
      record({ ...base, action: 'untracked', garmin_workout_id: link.garminWorkoutId });
      continue;
    }

    if (fatal) {
      record({ ...base, action: 'skipped' });
      continue;
    }
    if (dryRun) {
      record({ ...base, action: 'removed', garmin_workout_id: link.garminWorkoutId });
      continue;
    }
    if (budget.remaining < 2) {
      report.truncated = true;
      record({ ...base, action: 'skipped' });
      continue;
    }

    try {
      // The calendar entry first: a workout Garmin still has scheduled cannot
      // be deleted, and if only one of the two can be done, the one that
      // clears the athlete's calendar is the one that matters.
      if (link.garminScheduleId) {
        budget.remaining--;
        await unscheduleWorkout(connection.accessToken, link.garminScheduleId);
      }
      budget.remaining--;
      await deleteWorkout(connection.accessToken, link.garminWorkoutId);
      await store.deleteLink(env, userId, link.workoutId);
      record({ ...base, action: 'removed', garmin_workout_id: link.garminWorkoutId });
    } catch (error) {
      const message = errorMessage(error);
      record({ ...base, action: 'failed', error: message });
      if (isFatal(error)) fatal = message;
    }
  }

  if (fatal) report.error = fatal;

  if (!dryRun) {
    // What is remembered is whether the run left anything broken, so the
    // dashboard can say "last synced, with a problem" without syncing again
    // to find out. A truncated run is not a problem; it is a run that has
    // more to do.
    const failures = report.counts.failed;
    const summary = fatal ?? (failures > 0 ? `${failures} workout${failures > 1 ? 's' : ''} could not be synced` : null);
    await store.recordSync(env, userId, summary);
  }

  return report;
}

/**
 * The nightly sweep: push for every athlete who asked for it.
 *
 * Bounded, and ordered by how long it has been since each was last synced, so
 * a deployment with more connected athletes than one run can serve works
 * through them over successive nights instead of always starting at the same
 * end of the list.
 */
export async function syncEveryone(env: Env): Promise<{ users: number; pushed: number; failed: number }> {
  if (!isConfigured(env)) return { users: 0, pushed: 0, failed: 0 };

  const userIds = await store.autoSyncUserIds(env, MAX_USERS_PER_SWEEP);
  let pushed = 0;
  let failed = 0;

  for (const userId of userIds) {
    try {
      const report = await syncAll(env, userId);
      pushed += report.counts.created + report.counts.updated + report.counts.rescheduled + report.counts.removed;
      failed += report.counts.failed;
    } catch (error) {
      // One athlete's expired connection must not stop the sweep for the
      // rest, and it is already recorded against their own row.
      console.error(`nightly garmin sync failed for ${userId}`, error);
      failed++;
      await store.recordSync(env, userId, errorMessage(error)).catch(() => undefined);
    }
  }

  return { users: userIds.length, pushed, failed };
}

/** What the dashboard and the MCP tools are told, with no token material in it. */
export async function status(env: Env, userId: string): Promise<store.ConnectionStatus> {
  const configured = isConfigured(env);
  const connection = configured ? await store.getConnection(env, userId) : null;
  if (!connection) return { connected: false, configured };

  return {
    connected: true,
    configured,
    garmin_user_id: connection.garminUserId,
    connected_at: connection.connectedAt,
    last_sync_at: connection.lastSyncAt,
    last_sync_error: connection.lastSyncError,
    auto_sync: connection.autoSync,
    synced_workouts: await store.countLinks(env, userId),
  };
}
