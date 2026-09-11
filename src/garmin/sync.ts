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
 *
 * Its *transport* is known to be wrong: Garmin's Activity API is webhook-based
 * rather than pollable, so `pullCompletions` below will not get answers from
 * the real API until a receiver replaces it. `activities.ts` explains what
 * that redesign is and which parts of this survive it.
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

import {
  NotConnectedError,
  SyncBusyError,
  emptyCounts,
  emptyReport,
  newBudget,
} from '../sync';
import type { Budget, SyncAction, SyncEntry, SyncOptions, SyncReport } from '../sync';

/** Re-exported so this module stays the one door onto a Garmin sync. */
export type { Budget, SyncOptions, SyncReport } from '../sync';
export { newBudget } from '../sync';

/**
 * How many times a run will go round for work that arrived mid-flight.
 *
 * Bounded, because a plan being written continuously would otherwise keep one
 * run going indefinitely. Two extra passes is enough for the case this exists
 * for — a burst of writes while the first pass is in the air — and anything
 * still outstanding after that is caught by the next sync or the nightly one.
 */
export const MAX_SYNC_PASSES = 3;

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
    throw new NotConnectedError('no Garmin account is connected — connect one from the dashboard first');
  }

  // A dry run changes nothing on either side, so it neither takes the lock
  // nor waits for one: looking at what a sync would do is exactly the thing
  // to be able to do while one is running.
  if (dryRun) return run(env, stored, options, true, emptyReport(true));

  if (!(await store.claimSync(env, userId))) throw new SyncBusyError('Garmin');
  try {
    const report = emptyReport(false);

    // Writes that land while a run is in flight mark the connection, and this
    // is where that mark is honoured: a plan written a workout at a time — an
    // assistant filling in a training week — would otherwise have its first
    // write trigger a sync that pushes what existed at the time and its later
    // writes refused by the lock, leaving the tail of the plan for the nightly
    // sweep. Going round again is what makes the push after a write reliable
    // rather than merely likely.
    for (let pass = 0; pass < MAX_SYNC_PASSES; pass++) {
      const startedAt = new Date().toISOString();
      await run(env, stored, options, false, report);
      // Nothing more will fit, so another pass would only re-read the plan.
      if (report.truncated || report.error) break;
      if (!(await store.takeResyncRequest(env, userId, startedAt))) break;
    }
    return report;
  } finally {
    // Released even when the run threw, so one failure does not lock the
    // athlete out until the lock goes stale.
    await store.releaseSync(env, userId).catch(() => undefined);
  }
}

/**
 * The run itself, once the lock question is settled.
 *
 * Appends to the report it is given rather than making one, so a second pass
 * over a plan that grew mid-run reads as one result: `record` is keyed by
 * workout, so a workout skipped in the first pass and created in the second
 * appears once, as created.
 */
async function run(
  env: Env,
  stored: Connection,
  options: SyncOptions,
  dryRun: boolean,
  report: SyncReport,
): Promise<SyncReport> {
  const userId = stored.userId;
  const force = options.force === true;

  let connection: Connection = dryRun ? stored : await store.withFreshToken(env, stored);

  // One row per workout, last write winning, so a second pass corrects the
  // first rather than appending to it. The counts are derived from that at the
  // end, which is what keeps "48 unchanged" from appearing over 24 workouts.
  const entries = new Map<string, SyncEntry>();
  for (const entry of report.workouts) entries.set(`${entry.date}/${entry.id}`, entry);
  const record = (entry: SyncEntry): void => {
    entries.set(`${entry.date}/${entry.id}`, entry);
  };
  const publish = (): void => {
    report.workouts = [...entries.values()];
    report.counts = emptyCounts();
    for (const entry of report.workouts) report.counts[entry.action]++;
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
      record({ ...base, action: 'unchanged', remote_workout_id: link?.garminWorkoutId, ...notes });
      continue;
    }

    if (dryRun) {
      record({
        ...base,
        // A dry run says what the plan is by naming the action it would take.
        action: plan.do === 'create' ? 'created' : plan.do === 'update' ? 'updated' : 'rescheduled',
        remote_workout_id: link?.garminWorkoutId,
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
        remote_workout_id: updated.garminWorkoutId,
        ...(updated.garminScheduleId ? { remote_schedule_id: updated.garminScheduleId } : {}),
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
      record({ ...base, action: 'untracked', remote_workout_id: link.garminWorkoutId });
      continue;
    }

    if (fatal) {
      record({ ...base, action: 'skipped' });
      continue;
    }
    if (dryRun) {
      record({ ...base, action: 'removed', remote_workout_id: link.garminWorkoutId });
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
      record({ ...base, action: 'removed', remote_workout_id: link.garminWorkoutId });
    } catch (error) {
      const message = errorMessage(error);
      record({ ...base, action: 'failed', error: message });
      if (isFatal(error)) fatal = message;
    }
  }

  publish();

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
 * Best effort by design, which is doing more work than intended for now: the
 * activity query it depends on is built on a polling model Garmin does not
 * offer (see `activities.ts`), so until the webhook receiver exists this is
 * expected to leave a note rather than find anything. Being the optional half
 * of a sync — the plan is already on the calendar — a refused or unreachable
 * query never touches `fatal` and never fails the run.
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
