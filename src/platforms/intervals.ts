// intervals.icu: a planned workout is a WORKOUT-category event on their calendar.
// Their API notes, and why completions are polled, are in docs/integrations.md.

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

// Username is the literal `API_KEY`. `btoa` refuses non-Latin-1, which is a paste error, not a 500.
function authorization(key: string): string {
  try {
    return `Basic ${btoa(`API_KEY:${key}`)}`;
  } catch {
    return fail('that does not look like an intervals.icu API key');
  }
}

/** Their own complaint is read off the body — "401" alone does not say "key revoked". */
async function call(key: string, path: string, init: RequestInit = {}): Promise<Response> {
  // Outside the try, so a key `authorization` refuses is not reported as an outage.
  const headers = { Authorization: authorization(key), ...init.headers };

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
      // Their default is every field of every activity; these four are all pairing needs.
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
