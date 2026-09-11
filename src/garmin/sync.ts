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
 *
 * Once the plan is pushed, a run finishes by looking the other way: `activities.ts`
 * reads what the athlete actually recorded and ticks off the sessions it
 * accounts for. That is the half of the sync Garmin is authoritative for —
 * whether a session happened is something only the watch knows — and it only
 * ever sets a completion, never clears one. See that module for why.
 */

import * as db from '../db';
import type { Env } from '../db';
import type { Workout } from '../workout';
import { fingerprint } from './crypto';
import { GarminApiError, createWorkout, deleteWorkout, scheduleWorkout, unscheduleWorkout, updateWorkout } from './api';
import { UPLOAD_LOOKBACK_DAYS, activityLabel, completableRange, fetchActivities, matchCompletions, uploadWindows } from './activities';
import { buildWorkout } from './payload';
import type { GarminWorkout } from './payload';
import { GarminAuthError, isConfigured } from './oauth';
import * as store from './store';
import type { Connection, Link } from './store';

/**
 * The most Garmin calls one *Worker invocation* may make.
 *
 * A Worker gets a bounded number of outbound subrequests per invocation — 50
 * on the free plan this app is built to fit — and a workout costs one to four
 * of them, per `costOf`. So a run does what it can within budget and says how
 * much is left,
 * rather than dying partway through with no report. Nothing is lost: the next
 * run picks up exactly where this one stopped, because the diff is computed
 * from stored state rather than from where a cursor got to.
 *
 * The invocation is the unit, not the athlete, which matters for the nightly
 * sweep: five athletes with a budget each would have authorised 150 calls
 * against a limit of 50, and the calls past it fail as unreachable-network
 * errors — reported as the athlete's workouts failing rather than as this
 * server running out of room. `syncEveryone` therefore makes one budget and
 * passes it down, so the sweep degrades into "some athletes wait for tomorrow"
 * instead of "the last four athletes look broken".
 */
export const MAX_CALLS_PER_RUN = 30;

/** How many athletes the nightly sweep will look at, budget permitting. */
export const MAX_USERS_PER_SWEEP = 5;

/** Tracks the call budget, so every path spends from the same purse. */
export type Budget = { remaining: number };

export const newBudget = (limit = MAX_CALLS_PER_RUN): Budget => ({ remaining: limit });

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

/** A session Garmin says the athlete did, and the activity that says so. */
export type CompletedEntry = {
  date: string;
  id: string;
  name?: string;
  /** ISO instant, taken from when the activity started. */
  completed_at: string;
  activity: string;
};

export type SyncReport = {
  dry_run: boolean;
  /** Set when the call budget ran out; run again to finish. */
  truncated: boolean;
  counts: Record<SyncAction, number>;
  workouts: SyncEntry[];
  /**
   * Sessions ticked off from what the athlete recorded on Garmin. Empty on a
   * dry run, which makes no calls and so cannot ask.
   */
  completed: CompletedEntry[];
  /** Why the completion pull did not run, or did not run in full. */
  completed_note?: string;
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

/**
 * Another sync for this athlete is already in flight.
 *
 * Reported rather than queued: the run already going will push whatever this
 * one would have, so the useful answer is "it is happening" and not a second
 * pass over the same diff.
 */
export class GarminBusyError extends Error {
  constructor() {
    super('a Garmin sync is already running for this account — give it a moment and check again');
  }
}

// ---------------------------------------------------------------------------
// One workout
// ---------------------------------------------------------------------------

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
 * How many Garmin calls a plan costs.
 *
 * "Costs" nominally: the update paths can discover the workout is gone from
 * Garmin and spend up to three more calls putting it back. That is rare, and
 * `MAX_CALLS_PER_RUN` sits far enough below the real subrequest limit to
 * absorb it — whereas reserving for it on every workout stops a run several
 * calls early *every* time, to stand ready for something that almost never
 * happens. Being exact here is what lets a budget of two do the one create it
 * can afford instead of declining it.
 */
function costOf(plan: Exclude<Plan, { do: 'nothing' }>): number {
  switch (plan.do) {
    case 'create':
      return 2; // create, then schedule
    case 'update':
      return 1;
    case 'reschedule':
      return plan.link.garminScheduleId ? 2 : 1; // clear the old entry, if there is one
    case 'update-and-reschedule':
      return 1 + (plan.link.garminScheduleId ? 2 : 1);
  }
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
  /**
   * A call budget to spend from, for a caller syncing several athletes in one
   * Worker invocation. One athlete on their own gets a fresh one.
   */
  budget?: Budget;
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

  if (!isConfigured(env)) throw new GarminAuthError('Garmin sync is not configured on this server');

  const stored = await store.getConnection(env, userId);
  if (!stored) {
    throw new GarminAuthError('no Garmin account is connected — connect one from the dashboard first');
  }

  // A dry run changes nothing on either side, so it neither takes the lock
  // nor waits for one: looking at what a sync would do is exactly the thing
  // to be able to do while one is running.
  if (dryRun) return run(env, stored, options, true);

  if (!(await store.claimSync(env, userId))) throw new GarminBusyError();
  try {
    return await run(env, stored, options, false);
  } finally {
    // Released even when the run threw, so one failure does not lock the
    // athlete out until the lock goes stale.
    await store.releaseSync(env, userId).catch(() => undefined);
  }
}

/** The run itself, once the lock question is settled. */
async function run(env: Env, stored: Connection, options: SyncOptions, dryRun: boolean): Promise<SyncReport> {
  const userId = stored.userId;
  const force = options.force === true;

  let connection: Connection = dryRun ? stored : await store.withFreshToken(env, stored);

  const report: SyncReport = { dry_run: dryRun, truncated: false, counts: emptyCounts(), workouts: [], completed: [] };
  const record = (entry: SyncEntry): void => {
    report.counts[entry.action]++;
    report.workouts.push(entry);
  };

  const workouts = await db.listWorkouts(env, userId);
  const links = await store.listLinks(env, userId);
  const byWorkoutId = new Map(links.map((link) => [link.workoutId, link]));
  const seen = new Set<string>();

  const budget = dryRun ? newBudget(Number.POSITIVE_INFINITY) : (options.budget ?? newBudget());
  let fatal: string | undefined;

  /**
   * One workout's calls, with the single retry a 401 earns.
   *
   * `withFreshToken` refreshes five minutes early, so a 401 here is not an
   * expiry — it is a token invalidated behind our back, which a refresh may
   * well fix. Once per run: a second 401 is the grant genuinely being gone,
   * and retrying that forever would spend the whole budget proving it.
   */
  let refreshedMidRun = false;
  const attempt = async <T>(work: (token: string) => Promise<T>): Promise<T> => {
    try {
      return await work(connection.accessToken);
    } catch (error) {
      if (!(error instanceof GarminApiError) || error.status !== 401 || refreshedMidRun) throw error;
      refreshedMidRun = true;
      connection = await store.withFreshToken(env, connection, true);
      return work(connection.accessToken);
    }
  };

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

    // Stopping while this workout's own calls are still affordable means no
    // workout is ever half-applied for want of budget, only for want of
    // Garmin's cooperation.
    if (budget.remaining < costOf(plan)) {
      report.truncated = true;
      record({ ...base, action: 'skipped' });
      continue;
    }

    try {
      const { action, link: updated } = await attempt((token) =>
        apply(env, userId, token, workout, built.workout, current, plan, budget),
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
    // Clearing the entry, then deleting the workout — one call if there was
    // never an entry to clear.
    if (budget.remaining < (link.garminScheduleId ? 2 : 1)) {
      report.truncated = true;
      record({ ...base, action: 'skipped' });
      continue;
    }

    try {
      // The calendar entry first: a workout Garmin still has scheduled cannot
      // be deleted, and if only one of the two can be done, the one that
      // clears the athlete's calendar is the one that matters.
      await attempt(async (token) => {
        if (link.garminScheduleId) {
          budget.remaining--;
          await unscheduleWorkout(token, link.garminScheduleId);
        }
        budget.remaining--;
        await deleteWorkout(token, link.garminWorkoutId);
      });
      await store.deleteLink(env, userId, link.workoutId);
      record({ ...base, action: 'removed', garmin_workout_id: link.garminWorkoutId });
    } catch (error) {
      const message = errorMessage(error);
      record({ ...base, action: 'failed', error: message });
      if (isFatal(error)) fatal = message;
    }
  }

  // Last, and only with the plan already pushed: a run short of budget should
  // spend what it has getting sessions onto the watch before it spends any
  // reading history back.
  await pullCompletions(env, userId, workouts, report, { dryRun, fatal, budget, attempt });

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
 * Take completions from Garmin: tick off the sessions it accounts for.
 *
 * Best effort by design. This is the optional half of a sync — the plan is
 * already on the calendar — so a refused or unreachable activity query leaves
 * a note rather than failing the run, and never touches `fatal`.
 *
 * Only ever sets a completion. See `activities.ts` for why never clearing one
 * is the more important half of that rule.
 */
async function pullCompletions(
  env: Env,
  userId: string,
  workouts: Workout[],
  report: SyncReport,
  context: {
    dryRun: boolean;
    fatal: string | undefined;
    budget: Budget;
    attempt: <T>(work: (token: string) => Promise<T>) => Promise<T>;
  },
): Promise<void> {
  const { dryRun, fatal, budget, attempt } = context;

  if (dryRun) {
    report.completed_note = 'A preview makes no calls, so it cannot ask Garmin what was completed.';
    return;
  }
  if (fatal) return;

  // Only sessions that could plausibly have happened and have not been ticked
  // off — which is what makes the pull idempotent, and what makes a settled
  // plan of future workouts cost nothing to sync.
  const range = completableRange();
  const outstanding = workouts.filter(
    (workout) => !workout.completed_at && workout.date >= range.from && workout.date <= range.to,
  );
  if (outstanding.length === 0) return;

  if (budget.remaining < UPLOAD_LOOKBACK_DAYS) {
    report.truncated = true;
    report.completed_note = 'Ran out of calls before reading what was completed; the next sync will.';
    return;
  }

  const activities = [];
  let refused = 0;
  for (const window of uploadWindows()) {
    budget.remaining--;
    // `attempt` gives this the same one-401-retry the pushes get, so a token
    // invalidated mid-run does not cost the pull.
    const slice = await attempt((token) => fetchActivities(token, window)).catch(() => null);
    if (slice === null) refused++;
    else activities.push(...slice);
  }

  if (refused > 0) {
    report.completed_note =
      refused === UPLOAD_LOOKBACK_DAYS
        ? 'Garmin would not say what was completed; the plan was still pushed.'
        : `Garmin answered ${UPLOAD_LOOKBACK_DAYS - refused} of ${UPLOAD_LOOKBACK_DAYS} days of history.`;
  }

  for (const { workout, activity, completedAt } of matchCompletions(outstanding, activities)) {
    // `setCompleted` is the same write the dashboard's tick uses, so a session
    // completed from Garmin is indistinguishable from one ticked by hand —
    // which is the point: there is one notion of done.
    const updated = await db.setCompleted(env, userId, workout.date, workout.id, completedAt);
    if (!updated) continue;
    report.completed.push({
      date: workout.date,
      id: workout.id,
      name: workout.name,
      completed_at: completedAt,
      activity: activityLabel(activity),
    });
  }
}

/**
 * The nightly sweep: push for every athlete who asked for it.
 *
 * Bounded, and ordered by how long it has been since each was last synced, so
 * a deployment with more connected athletes than one run can serve works
 * through them over successive nights instead of always starting at the same
 * end of the list.
 */
export async function syncEveryone(
  env: Env,
): Promise<{ users: number; pushed: number; completed: number; failed: number; budgetSpent: boolean }> {
  if (!isConfigured(env)) return { users: 0, pushed: 0, completed: 0, failed: 0, budgetSpent: false };

  const userIds = await store.autoSyncUserIds(env, MAX_USERS_PER_SWEEP);
  // One budget for the whole invocation, because the subrequest limit is per
  // invocation. See `MAX_CALLS_PER_RUN`.
  const budget = newBudget();
  let users = 0;
  let pushed = 0;
  let completed = 0;
  let failed = 0;

  for (const userId of userIds) {
    // Enough to create and schedule one workout, which is the least a turn
    // for an athlete is worth taking. Below it the remaining athletes are
    // left untouched rather than half-served; they sort first tomorrow,
    // since `autoSyncUserIds` orders by how long it has been.
    if (budget.remaining < 2) break;
    users++;

    try {
      const report = await syncAll(env, userId, { budget });
      pushed += report.counts.created + report.counts.updated + report.counts.rescheduled + report.counts.removed;
      completed += report.completed.length;
      failed += report.counts.failed;
    } catch (error) {
      // One athlete's expired connection must not stop the sweep for the
      // rest, and it is already recorded against their own row. A busy
      // athlete is not a failure at all — someone is already syncing them.
      if (error instanceof GarminBusyError) continue;
      console.error(`nightly garmin sync failed for ${userId}`, error);
      failed++;
      await store.recordSync(env, userId, errorMessage(error)).catch(() => undefined);
    }
  }

  return { users, pushed, completed, failed, budgetSpent: budget.remaining < 2 };
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
