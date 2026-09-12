// intervals.icu: a planned workout is a WORKOUT-category event on their calendar.
// Their API notes, and why completions are polled, are in docs/integrations.md.

import { base64Encode, encodeWorkoutFit, fitFilename } from '../fit';
import type { Sport, SubSport, Workout } from '../workout';
import { PlatformError } from './types';
import type { Completion, Outbound, Platform, Recorded, RecordedFile } from './types';

const BASE = 'https://intervals.icu/api/v1';

/** `0` is "the athlete this credential belongs to". */
const ATHLETE = '0';

/** Their sport names. Anything we cannot place is a generic workout. */
const ACTIVITY_TYPE: Record<Sport, string> = {
  running: 'Run',
  cycling: 'Ride',
  swimming: 'Swim',
  walking: 'Walk',
  hiking: 'Hike',
  rowing: 'Rowing',
  training: 'WeightTraining',
  generic: 'Workout',
};

/** Sub-sports that are a distinct activity type upstream rather than a flag. */
const BY_SUB_SPORT: Partial<Record<SubSport, string>> = {
  trail: 'TrailRun',
  mountain: 'MountainBikeRide',
  open_water: 'OpenWaterSwim',
};

/** A virtual session is its own type per sport, where they have one. */
const VIRTUAL: Partial<Record<Sport, string>> = {
  running: 'VirtualRun',
  cycling: 'VirtualRide',
  rowing: 'VirtualRow',
};

const INDOOR_SUB_SPORTS = new Set<SubSport>([
  'treadmill',
  'indoor_cycling',
  'spin',
  'lap_swimming',
  'indoor_rowing',
  'indoor_walking',
  'virtual_activity',
]);

/**
 * Their activity types placed back on our scale, for the sport filter in
 * `src/recordings/`.
 *
 * Derived from the maps above wherever it can be, so a sport added there is
 * matched here without a second edit, and listed by hand only where it cannot:
 * a sub-sport type does not say which sport it belongs to, and an athlete
 * records plenty of types we would never push. Anything still unplaced stays
 * `null` rather than becoming `generic` — "we could not tell" and "a generic
 * workout" are different answers, and only the second should match a filter.
 */
const SPORT_BY_TYPE = new Map<string, Sport>([
  ...Object.entries(ACTIVITY_TYPE).map(([sport, type]) => [type.toLowerCase(), sport as Sport] as const),
  ...Object.entries(VIRTUAL).map(([sport, type]) => [type.toLowerCase(), sport as Sport] as const),
  // The sub-sport types from `BY_SUB_SPORT`, plus the ones they record and we do not write.
  ...(
    [
      ['TrailRun', 'running'],
      ['OpenWaterSwim', 'swimming'],
      ['MountainBikeRide', 'cycling'],
      ['GravelRide', 'cycling'],
      ['EBikeRide', 'cycling'],
      ['EMountainBikeRide', 'cycling'],
      ['Handcycle', 'cycling'],
      ['Velomobile', 'cycling'],
      ['VirtualRow', 'rowing'],
      ['Elliptical', 'training'],
      ['StairStepper', 'training'],
      ['Crossfit', 'training'],
      ['Yoga', 'training'],
    ] satisfies Array<[string, Sport]>
  ).map(([type, sport]) => [type.toLowerCase(), sport] as const),
]);

/** What sport a recorded activity counts as, or null when we cannot place it. */
export const sportOf = (type: string | null | undefined): Sport | null =>
  (type && SPORT_BY_TYPE.get(type.trim().toLowerCase())) || null;

export function activityType(workout: Pick<Workout, 'sport' | 'sub_sport'>): string {
  if (workout.sub_sport === 'virtual_activity') {
    return VIRTUAL[workout.sport] ?? ACTIVITY_TYPE[workout.sport];
  }
  return (workout.sub_sport && BY_SUB_SPORT[workout.sub_sport]) || ACTIVITY_TYPE[workout.sport];
}

/** Whether the watch should be told not to wait for GPS. */
const isIndoor = (workout: Pick<Workout, 'sub_sport'>): boolean =>
  workout.sub_sport !== undefined && INDOOR_SUB_SPORTS.has(workout.sub_sport);

const fail = (message: string): never => {
  throw new PlatformError('intervals', message);
};

/** Their own complaint is read off the body — "401" alone does not say "grant revoked". */
async function call(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = { Authorization: `Bearer ${token}`, ...init.headers };

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch (err) {
    return fail(`could not reach intervals.icu (${(err as Error).message})`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const detail = body.trim().replace(/\s+/g, ' ').slice(0, 200);
    return fail(`intervals.icu answered ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return response;
}

const postJson = (token: string, path: string, body: unknown): Promise<Response> =>
  call(token, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    return fail('intervals.icu returned a response that was not JSON');
  }
}

type Event = { id?: number; push_errors?: unknown[] };
type Activity = { paired_event_id?: number | null; start_date?: string | null; start_date_local?: string | null };

type RecordedActivity = Activity & {
  id?: string | null;
  name?: string | null;
  /** What the athlete uploaded — `fit`, `gpx`, `tcx` — or absent for Strava and manual entries. */
  file_type?: string | null;
  /** Their activity type, e.g. `Run`, `TrailRun`, `VirtualRide`. */
  type?: string | null;
  distance?: number | null;
  moving_time?: number | null;
};

/** The athlete's own day, which is the day a session belongs to however far east they flew. */
const localDay = (activity: RecordedActivity): string =>
  (activity.start_date_local ?? activity.start_date ?? '').slice(0, 10);

/** Their numbers come back as numbers, but a null or a string is not worth trusting on. */
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** `start_date` is UTC; the local fallback carries no offset, so it is read as UTC too. */
function startedAt(activity: Activity): string | null {
  const raw = activity.start_date ?? activity.start_date_local;
  if (!raw) return null;
  const parsed = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export const intervals: Platform = {
  id: 'intervals',
  label: 'intervals.icu',
  connect_help:
    'Connect intervals.icu to sync your workouts to its calendar, and have the sessions you ' +
    'record there come back here as done.',
  // They store every target as a percentage of a threshold, so a profile missing one
  // shows the step with no usable target however right the file is. See integrations.md.
  connected_note:
    'Targets are read against your intervals.icu thresholds. If a pace or a power target looks ' +
    'wrong there, set your threshold pace and FTP in their settings.',

  // Upserted on `external_id`, which they match against the events this app itself
  // created, so a re-push updates the one already there. Not `uid` and the single-event
  // endpoint's `upsertOnUid`: `uid` is a UUID intervals.icu generates for an event, not
  // a key we get to choose, so ours never matched and every edit left a second event
  // behind. See "How a push works" in docs/integrations.md.
  async push(token, { workout, syncKey }: Outbound) {
    const saved = await readJson<Event[]>(
      await postJson(token, `/athlete/${ATHLETE}/events/bulk?upsert=true`, [
        {
          external_id: syncKey,
          category: 'WORKOUT',
          // Their calendar is keyed on the athlete's local day, which is what our `date` is.
          start_date_local: `${workout.date}T00:00:00`,
          type: activityType(workout),
          name: workout.name,
          indoor: isIndoor(workout),
          filename: fitFilename(workout),
          file_contents_base64: base64Encode(encodeWorkoutFit(workout)),
        },
      ]),
    );

    // One event in, one event back: anything else and we do not know what is on the calendar.
    if (!Array.isArray(saved) || saved.length !== 1) fail('intervals.icu did not say what it saved');
    const event = saved[0];

    // The call can succeed while the FIT file inside it did not parse, leaving an event with no steps.
    if (Array.isArray(event.push_errors) && event.push_errors.length > 0) {
      fail(`intervals.icu could not read the workout: ${event.push_errors.join('; ').slice(0, 200)}`);
    }
    if (event.id === undefined || event.id === null) fail('intervals.icu did not return an event id');
    return String(event.id);
  },

  async remove(token, remoteId) {
    try {
      await call(token, `/athlete/${ATHLETE}/events/${encodeURIComponent(remoteId)}`, { method: 'DELETE' });
    } catch (err) {
      // Already gone is the state we were asking for. Anything else is real.
      if (err instanceof PlatformError && / 404\b/.test(err.message)) return;
      throw err;
    }
  },

  // Handed back, so disconnecting here also drops the app from their intervals.icu settings.
  async revoke(token) {
    try {
      await call(token, '/disconnect-app', { method: 'DELETE' });
    } catch (err) {
      // Already revoked upstream, or revoked from their settings page: the state we wanted.
      if (err instanceof PlatformError && / 40[0134]\b/.test(err.message)) return;
      throw err;
    }
  },

  async completions(token, from, to) {
    const query = new URLSearchParams({
      oldest: from,
      newest: to,
      // Their default is every field of every activity; these four are all pairing needs.
      fields: 'id,paired_event_id,start_date,start_date_local',
    });
    const activities = await readJson<Activity[]>(
      await call(token, `/athlete/${ATHLETE}/activities?${query}`),
    );
    if (!Array.isArray(activities)) fail('intervals.icu returned an unexpected activity list');

    const completions: Completion[] = [];
    for (const activity of activities) {
      if (!activity?.paired_event_id) continue;
      const completedAt = startedAt(activity);
      if (completedAt) completions.push({ remote_id: String(activity.paired_event_id), completed_at: completedAt });
    }
    return completions;
  },

  // Everything the athlete recorded, unfiltered: what is worth copying is the
  // caller's question, and `src/drive/` answers it with what it has already copied.
  async activities(token, from, to) {
    const query = new URLSearchParams({
      oldest: from,
      newest: to,
      fields: 'id,name,start_date,start_date_local,file_type,type,distance,moving_time',
    });
    const activities = await readJson<RecordedActivity[]>(
      await call(token, `/athlete/${ATHLETE}/activities?${query}`),
    );
    if (!Array.isArray(activities)) fail('intervals.icu returned an unexpected activity list');

    const recorded: Recorded[] = [];
    for (const activity of activities) {
      const date = localDay(activity);
      if (!activity.id || !date) continue;
      recorded.push({
        remote_id: String(activity.id),
        date,
        name: activity.name?.trim() || 'workout',
        original_type: activity.file_type ?? null,
        activity_type: activity.type ?? null,
        sport: sportOf(activity.type),
        distance_m: number(activity.distance),
        moving_time_s: number(activity.moving_time),
      });
    }
    return recorded;
  },

  // `/file` is the athlete's own upload; `/fit-file` is one intervals.icu builds from the
  // streams, which is the only FIT there is when they uploaded a GPX or came via Strava.
  async recording(token, recorded) {
    const id = encodeURIComponent(recorded.remote_id);
    const path = /^\.?fit$/i.test(recorded.original_type ?? '')
      ? `/activity/${id}/file`
      : `/activity/${id}/fit-file`;

    const response = await call(token, path);
    const body = response.body ?? fail(`intervals.icu sent no file for activity ${recorded.remote_id}`);

    const length = Number(response.headers.get('Content-Length'));
    return {
      body,
      content_type: 'application/vnd.ant.fit',
      content_length: Number.isFinite(length) && length > 0 ? length : null,
    } satisfies RecordedFile;
  },
};
