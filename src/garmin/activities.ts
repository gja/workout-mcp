/**
 * What the athlete actually did, coming back the other way.
 *
 * The plan goes out to the calendar; completion comes back. That asymmetry is
 * not a shortcut — it is where the truth lives. Whether a session happened is
 * something only the watch knows, and Garmin's calendar takes no "done" flag
 * from us, so there is nothing to push in that direction. What there is, is a
 * record of activities the athlete recorded, and matching those against the
 * plan is what ticks a session off here without anyone typing anything.
 *
 * Two rules govern it, and both matter more than the matching itself:
 *
 *   - **Only ever set, never clear.** A workout Garmin has no activity for is
 *     left exactly as it is. Garmin not knowing about a session is not
 *     evidence it did not happen — a treadmill run logged by hand here has no
 *     activity behind it — and erasing the athlete's own tick because a third
 *     party has not heard of it would be indefensible.
 *   - **Already-completed workouts are skipped**, which is what makes the pull
 *     idempotent and cheap: it only ever looks at what is still outstanding.
 *
 * As with `payload.ts`, the Activity API's exact field spellings are
 * documented behind the developer portal's login. The matching below is a pure
 * function over a small, named shape, so correcting a field name or an
 * activity type is a one-line change here.
 */

import { shiftDate, today } from '../units';
import type { Sport, Workout } from '../workout';
import { API_BASE } from './oauth';

/**
 * An activity summary, reduced to the fields matching needs.
 *
 * Everything is optional because this is a third party's payload: a summary
 * missing a start time is one we cannot place on a day, and the right answer
 * to that is to skip it rather than to guess.
 */
export type GarminActivity = {
  summaryId?: string;
  activityId?: number | string;
  activityName?: string;
  activityType?: string;
  /** Unix seconds, UTC. */
  startTimeInSeconds?: number;
  /** Seconds to add for the athlete's local time, which is the day they ran. */
  startTimeOffsetInSeconds?: number;
  durationInSeconds?: number;
  distanceInMeters?: number;
};

/**
 * How far back to look for uploads, in whole days.
 *
 * Uploads lag the activity: a session recorded on Saturday evening reaches
 * Garmin when the watch next syncs, which may be Sunday. Three days covers
 * that comfortably without turning the pull into the expensive half of a sync.
 */
export const UPLOAD_LOOKBACK_DAYS = 3;

/**
 * Garmin bounds an activity query to a 24-hour slice of upload time, so a
 * lookback of several days is several requests. One constant, so the cost of
 * the pull is `UPLOAD_LOOKBACK_DAYS` calls and visibly so.
 */
export const UPLOAD_WINDOW_SECONDS = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** The upload-time slices to ask for, newest first. */
export function uploadWindows(now: Date = new Date(), days = UPLOAD_LOOKBACK_DAYS): Array<[number, number]> {
  const end = Math.floor(now.getTime() / 1000);
  return Array.from({ length: days }, (_, index) => {
    const to = end - index * UPLOAD_WINDOW_SECONDS;
    return [to - UPLOAD_WINDOW_SECONDS, to] as [number, number];
  });
}

/**
 * One slice of the athlete's recorded activities.
 *
 * Returns `null` rather than throwing when Garmin refuses. A sync whose push
 * worked should not be reported as failed because the optional half could not
 * read history — the caller counts the slices it got and says so.
 */
export async function fetchActivities(
  accessToken: string,
  [from, to]: [number, number],
): Promise<GarminActivity[] | null> {
  const url = new URL(`${API_BASE}/activity-api/rest/activities`);
  url.searchParams.set('uploadStartTimeInSeconds', String(from));
  url.searchParams.set('uploadEndTimeInSeconds', String(to));

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      console.error(`garmin activity query returned ${response.status}`, (await response.text()).slice(0, 300));
      return null;
    }
    const payload = (await response.json()) as unknown;
    // A single object rather than a list is accepted too: it costs one line
    // and saves the pull silently returning nothing if Garmin ever answers
    // that way.
    if (Array.isArray(payload)) return payload as GarminActivity[];
    return payload && typeof payload === 'object' ? [payload as GarminActivity] : [];
  } catch (error) {
    console.error('garmin activity query failed', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Garmin's activity type to ours, by what the name contains.
 *
 * Patterns rather than an exhaustive table, deliberately. Garmin's activity
 * type enum is long, versioned and documented behind a login, and it gains
 * entries — `GRAVEL_CYCLING`, `VIRTUAL_RUN`, `E_BIKE_FITNESS` all arrived
 * after the original set. A list I cannot verify would silently fail to match
 * whatever it omits; a pattern catches the family and keeps catching it.
 *
 * Order matters where names overlap: `OPEN_WATER_SWIMMING` must be a swim
 * before `WATER` suggests anything else, and the catch-all gym family is last
 * because `STRENGTH_TRAINING` would otherwise be claimed by `TRAINING`.
 */
const SPORT_PATTERNS: ReadonlyArray<[RegExp, Sport]> = [
  [/SWIM|SNORKEL|DIVING/, 'swimming'],
  [/ROW|PADDL|KAYAK/, 'rowing'],
  [/HIK|MOUNTAINEER/, 'hiking'],
  [/WALK/, 'walking'],
  [/RUN/, 'running'],
  [/CYCL|BIK|RIDE|SPIN|HANDCYCLING/, 'cycling'],
  [/STRENGTH|CARDIO|HIIT|YOGA|PILATES|FITNESS|TRAINING|BREATHWORK/, 'training'],
];

/** Which of our sports an activity counts as, or null if we cannot tell. */
export function sportOf(activityType: string | undefined): Sport | null {
  if (!activityType) return null;
  const name = activityType.toUpperCase();
  for (const [pattern, sport] of SPORT_PATTERNS) {
    if (pattern.test(name)) return sport;
  }
  return null;
}

/**
 * The athlete's local day for an activity, as `YYYY-MM-DD`.
 *
 * The offset is what makes this the day they would say they ran: a 06:30 run
 * in Auckland is the previous day in UTC, and matching it against a plan
 * written for the local day has to agree with the athlete, not with the clock
 * on this server.
 */
export function localDateOf(activity: GarminActivity): string | null {
  if (typeof activity.startTimeInSeconds !== 'number') return null;
  const local = (activity.startTimeInSeconds + (activity.startTimeOffsetInSeconds ?? 0)) * 1000;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** The instant to record as the completion: the activity's own start. */
const completedAtOf = (activity: GarminActivity): string =>
  new Date((activity.startTimeInSeconds as number) * 1000).toISOString();

export type Completion = {
  workout: Workout;
  activity: GarminActivity;
  /** ISO instant, taken from when the activity started. */
  completedAt: string;
};

/**
 * A workout's planned seconds, for telling two same-day sessions apart.
 *
 * Deliberately not `plannedTotals`: this only needs a rough size to compare
 * against, and resolving every step of every workout to get one would be a
 * lot of work for a tie-break.
 */
function plannedSeconds(workout: Workout): number | null {
  let total = 0;
  const walk = (steps: Workout['steps'], multiplier: number): void => {
    for (const step of steps) {
      if ('repeat' in step) {
        walk(step.steps, multiplier * step.repeat);
        continue;
      }
      const goal = (step as Record<string, unknown>).goal_s;
      if (typeof goal === 'number') total += goal * multiplier;
    }
  };
  walk(workout.steps, 1);
  return total > 0 ? total : null;
}

/**
 * Pair outstanding workouts with the activities that completed them.
 *
 * Pure, so the rules can be tested without a network, and so the rules are
 * readable in one place:
 *
 *   - a workout already marked done is not considered at all;
 *   - an activity matches a workout on the same *local* day whose sport it is
 *     (a `generic` plan accepts any sport, since that is what generic means);
 *   - each activity completes at most one workout and each workout takes at
 *     most one activity, so two sessions on a day need two activities;
 *   - where a day holds more than one candidate, the closest by planned
 *     duration wins — otherwise an easy hour and a hard twenty minutes on the
 *     same Tuesday would be ticked off by whichever came back first.
 */
export function matchCompletions(workouts: Workout[], activities: GarminActivity[]): Completion[] {
  const usable = activities
    .map((activity) => ({ activity, date: localDateOf(activity), sport: sportOf(activity.activityType) }))
    .filter((entry): entry is { activity: GarminActivity; date: string; sport: Sport | null } => entry.date !== null);

  const taken = new Set<GarminActivity>();
  const completions: Completion[] = [];

  for (const workout of workouts) {
    if (workout.completed_at) continue;

    const candidates = usable.filter(
      (entry) =>
        !taken.has(entry.activity) &&
        entry.date === workout.date &&
        (workout.sport === 'generic' || entry.sport === workout.sport),
    );
    if (candidates.length === 0) continue;

    const target = plannedSeconds(workout);
    const best =
      target === null
        ? candidates[0]
        : candidates.reduce((closest, entry) => {
            const gap = (candidate: (typeof candidates)[number]): number =>
              Math.abs((candidate.activity.durationInSeconds ?? 0) - target);
            return gap(entry) < gap(closest) ? entry : closest;
          }, candidates[0]);

    taken.add(best.activity);
    completions.push({ workout, activity: best.activity, completedAt: completedAtOf(best.activity) });
  }

  return completions;
}

/** How the report names the activity behind a completion. */
export const activityLabel = (activity: GarminActivity): string =>
  activity.activityName ?? String(activity.activityId ?? activity.summaryId ?? activity.activityType ?? 'an activity');

/**
 * The dates a pull could sensibly complete anything on.
 *
 * Bounded at both ends, and the upper bound is the one that matters: a session
 * planned for Thursday cannot have been done on Monday, so a window with
 * nothing but future sessions in it needs no activity query at all — which is
 * what keeps an unchanged sync free rather than costing three calls to
 * rediscover that next week has not happened yet.
 *
 * A day of slack past today, for the same reason `db.readWindow` has it: dates
 * are the athlete's local day while this is reckoned in UTC, so an athlete
 * ahead of UTC is already living in tomorrow's date.
 */
export const completableRange = (now: Date = new Date()): { from: string; to: string } => {
  const day = today(now);
  return { from: shiftDate(day, -(UPLOAD_LOOKBACK_DAYS + 1)), to: shiftDate(day, 1) };
};
