/**
 * intervals.icu.
 *
 * A planned workout is an *event* on the athlete's calendar, in the WORKOUT
 * category. Three things about their API shape this file:
 *
 *  - The athlete id in a path may be `0`, which means "whoever the credential
 *    belongs to", so nothing here has to look an athlete up before writing.
 *  - Creating an event takes `upsertOnUid`, so create and update are the same
 *    call under a key we choose. That is what makes a re-push idempotent and
 *    a lost `remote_id` recoverable rather than a duplicate on the calendar.
 *  - The event endpoint accepts a FIT workout file, so the structure we send
 *    is exactly the one a watch would get, down to the nested repeats and the
 *    open-ended steps. Serialising to their text format instead would mean a
 *    second encoder to keep in step with the first, and their text repeats do
 *    not nest.
 *
 * Completion comes back the other way: when an athlete records a session,
 * intervals.icu matches it to the planned event and the activity carries a
 * `paired_event_id`. That is what `completions` reads. There is no webhook to
 * subscribe to here — intervals.icu only delivers those to OAuth applications
 * it has approved, and this integration is a key the athlete pastes in — so
 * the pairing is polled rather than pushed. See `sync.pullCompletions`.
 */

import { base64Encode, encodeWorkoutFit, fitFilename } from '../fit';
import type { Sport, SubSport, Workout } from '../workout';
import { PlatformError } from './types';
import type { Account, Completion, Outbound, Platform } from './types';

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

/**
 * Username is the literal `API_KEY`; the password is the athlete's key.
 *
 * `btoa` refuses anything outside Latin-1, and what is in the box is whatever
 * was pasted — so a key with a stray non-ASCII character is the athlete's
 * mistake to be told about, not a 500.
 */
function authorization(key: string): string {
  try {
    return `Basic ${btoa(`API_KEY:${key}`)}`;
  } catch {
    return fail('that does not look like an intervals.icu API key');
  }
}

/**
 * One call, with the platform's own complaint carried through.
 *
 * A body is read on failure because intervals.icu explains itself there, and
 * "401 Unauthorized" alone does not tell an athlete their key was revoked.
 * Anything that is not JSON is trimmed to a line so a stray HTML error page
 * does not become the message on the dashboard.
 */
async function call(key: string, path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { Authorization: authorization(key), ...init.headers },
    });
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

const postJson = (key: string, path: string, body: unknown): Promise<Response> =>
  call(key, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    return fail('intervals.icu returned a response that was not JSON');
  }
}

type Athlete = { id?: string; name?: string };
type Event = { id?: number; push_errors?: unknown[] };
type Activity = { paired_event_id?: number | null; start_date?: string | null; start_date_local?: string | null };

/**
 * An instant from an activity.
 *
 * `start_date` is UTC and is what we want; `start_date_local` is the athlete's
 * wall clock with no offset on it, so it is only a fallback and is read as UTC
 * rather than guessed at. Either way an unparseable value is dropped instead
 * of becoming an `Invalid Date` in the database.
 */
function startedAt(activity: Activity): string | null {
  const raw = activity.start_date ?? activity.start_date_local;
  if (!raw) return null;
  const parsed = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export const intervals: Platform = {
  id: 'intervals',
  label: 'intervals.icu',
  credential: {
    label: 'API key',
    help: 'In intervals.icu, open Settings and find the Developer Settings box at the bottom.',
    help_url: 'https://intervals.icu/settings',
  },

  async verify(key) {
    const athlete = await readJson<Athlete>(await call(key, `/athlete/${ATHLETE}`));
    if (!athlete.id) fail('that key did not identify an intervals.icu athlete');
    return { id: String(athlete.id), name: athlete.name ?? null } satisfies Account;
  },

  async push(key, { workout, syncKey }: Outbound) {
    const event = await readJson<Event>(
      await postJson(key, `/athlete/${ATHLETE}/events?upsertOnUid=true`, {
        uid: syncKey,
        category: 'WORKOUT',
        // Their calendar is keyed on the athlete's local day, which is exactly
        // what our `date` is, so midnight local is the honest start.
        start_date_local: `${workout.date}T00:00:00`,
        type: activityType(workout),
        name: workout.name,
        indoor: isIndoor(workout),
        // Our own id, so a person poking at their calendar can tell where the
        // event came from. The upsert key is `uid`; this is only a label.
        external_id: workout.id,
        filename: fitFilename(workout),
        file_contents_base64: base64Encode(encodeWorkoutFit(workout)),
      }),
    );

    // The call can succeed while the file inside it did not parse, in which
    // case the event exists but has no steps. Saying so beats recording a
    // clean sync for a calendar entry the athlete cannot train off.
    if (Array.isArray(event.push_errors) && event.push_errors.length > 0) {
      fail(`intervals.icu could not read the workout: ${event.push_errors.join('; ').slice(0, 200)}`);
    }
    if (event.id === undefined || event.id === null) fail('intervals.icu did not return an event id');
    return String(event.id);
  },

  async remove(key, remoteId) {
    try {
      await call(key, `/athlete/${ATHLETE}/events/${encodeURIComponent(remoteId)}`, { method: 'DELETE' });
    } catch (err) {
      // Already gone is the state we were asking for. Anything else is real.
      if (err instanceof PlatformError && / 404\b/.test(err.message)) return;
      throw err;
    }
  },

  async completions(key, from, to) {
    const query = new URLSearchParams({
      oldest: from,
      newest: to,
      // Their default is every field of every activity, which is a large
      // document; these four are the whole of what pairing needs.
      fields: 'id,paired_event_id,start_date,start_date_local',
    });
    const activities = await readJson<Activity[]>(
      await call(key, `/athlete/${ATHLETE}/activities?${query}`),
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
};
