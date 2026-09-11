/**
 * The Garmin Connect Training API, which is what puts a workout on the
 * athlete's calendar.
 *
 * Two resources, and the distinction between them is the whole model:
 *
 *   - a *workout* is the session itself, and lives in the athlete's workout
 *     library. Creating one does not put it on any date.
 *   - a *schedule* attaches a workout to a day. That is the calendar entry,
 *     and it is what a watch picks up when it syncs.
 *
 * So one of ours becomes two of theirs, and moving a workout to another day
 * means replacing the schedule while keeping the workout — which is why
 * `garmin_workouts` stores both ids.
 *
 * Every call reports Garmin's own status and response body on failure. That
 * is deliberate: this is a partner API whose exact field spellings are
 * documented behind a login, so when a payload is refused, the message Garmin
 * gives is the thing that says which field to fix.
 */

import { API_BASE } from './oauth';

const TRAINING_BASE = `${API_BASE}/training-api`;

/**
 * A call Garmin refused.
 *
 * `status` is kept apart from the message because the caller acts on it: a
 * 401 is worth one retry with a fresh token (`sync.ts` spends it), a 429 means
 * stop for now, and a 404 on a delete means the thing is already gone, which
 * is success.
 */
export class GarminApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, what: string) {
    super(`Garmin refused to ${what} (HTTP ${status})${body ? `: ${body}` : ''}`);
    this.status = status;
    this.body = body;
  }
}

type Call = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  /** For the error message: "create the workout", "schedule it on 2026-09-12". */
  what: string;
};

/**
 * One Training API call.
 *
 * `accessToken` is passed rather than the connection, so this module stays
 * unaware of how tokens are stored or refreshed — `sync.ts` owns that, and
 * owns the one retry a 401 earns.
 */
async function call(accessToken: string, { method, path, body, what }: Call): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${TRAINING_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    console.error(`garmin ${method} ${path} failed`, error);
    // Reported as a 503, so it lands with Garmin's own outages rather than
    // with a refused payload: a network failure is one workout's bad luck and
    // not a reason to stop the run, which is exactly how `isFatal` reads it.
    throw new GarminApiError(503, 'the request did not reach Garmin', what);
  }

  const text = await response.text();
  if (!response.ok) throw new GarminApiError(response.status, text.slice(0, 500), what);

  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * An id out of a Training API response.
 *
 * Garmin returns these as JSON numbers, which we store and send back as
 * strings: they are identifiers rather than quantities, and a workout id
 * large enough to lose precision as a double is a bug that would be very hard
 * to see. Both spellings are accepted because a bare number is also a valid
 * body for a single-id response.
 */
function readId(payload: unknown, keys: string[], what: string): string {
  if (typeof payload === 'number' || typeof payload === 'string') return String(payload);

  if (payload && typeof payload === 'object') {
    for (const key of keys) {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === 'number' || (typeof value === 'string' && value !== '')) return String(value);
    }
  }
  throw new GarminApiError(502, `no id in Garmin's response to ${what}`, what);
}

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

export async function createWorkout(accessToken: string, workout: unknown): Promise<string> {
  const payload = await call(accessToken, { method: 'POST', path: '/workout', body: workout, what: 'create the workout' });
  return readId(payload, ['workoutId', 'id'], 'create the workout');
}

export const updateWorkout = (accessToken: string, garminWorkoutId: string, workout: unknown): Promise<unknown> =>
  call(accessToken, {
    method: 'PUT',
    path: `/workout/${encodeURIComponent(garminWorkoutId)}`,
    body: workout,
    what: 'update the workout',
  });

/**
 * Deletes are idempotent: a workout Garmin has already lost — deleted in the
 * Connect app, say — is the state we were asking for, so a 404 is success.
 */
export async function deleteWorkout(accessToken: string, garminWorkoutId: string): Promise<void> {
  try {
    await call(accessToken, {
      method: 'DELETE',
      path: `/workout/${encodeURIComponent(garminWorkoutId)}`,
      what: 'delete the workout',
    });
  } catch (error) {
    if (error instanceof GarminApiError && error.status === 404) return;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The calendar
// ---------------------------------------------------------------------------

/** Put a workout on a date. This is the calendar entry. */
export async function scheduleWorkout(accessToken: string, garminWorkoutId: string, date: string): Promise<string> {
  const what = `schedule the workout on ${date}`;
  const payload = await call(accessToken, {
    method: 'POST',
    path: '/schedule',
    // Sent as a number, because that is how Garmin gave it to us; the string
    // is our storage form, not their wire form.
    body: { workoutId: Number(garminWorkoutId), date },
    what,
  });
  return readId(payload, ['workoutScheduleId', 'scheduleId', 'id'], what);
}

export async function unscheduleWorkout(accessToken: string, garminScheduleId: string): Promise<void> {
  try {
    await call(accessToken, {
      method: 'DELETE',
      path: `/schedule/${encodeURIComponent(garminScheduleId)}`,
      what: 'remove the calendar entry',
    });
  } catch (error) {
    if (error instanceof GarminApiError && error.status === 404) return;
    throw error;
  }
}
