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
};

/** The athlete's own day, which is the day a session belongs to however far east they flew. */
const localDay = (activity: RecordedActivity): string =>
  (activity.start_date_local ?? activity.start_date ?? '').slice(0, 10);

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

  async push(token, { workout, syncKey }: Outbound) {
    const event = await readJson<Event>(
      await postJson(token, `/athlete/${ATHLETE}/events?upsertOnUid=true`, {
        uid: syncKey,
        category: 'WORKOUT',
        // Their calendar is keyed on the athlete's local day, which is what our `date` is.
        start_date_local: `${workout.date}T00:00:00`,
        type: activityType(workout),
        name: workout.name,
        indoor: isIndoor(workout),
        // A label only — `uid` is the upsert key — so a person can see where the event came from.
        external_id: workout.id,
        filename: fitFilename(workout),
        file_contents_base64: base64Encode(encodeWorkoutFit(workout)),
      }),
    );

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
      fields: 'id,name,start_date,start_date_local,file_type',
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
