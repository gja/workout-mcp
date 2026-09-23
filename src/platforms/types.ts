// What a training platform has to be able to do. Adapters are stateless — handed
// the athlete's OAuth access token on every call, storing nothing. See docs/architecture.md.

import type { Sport, Workout, WorkoutInput } from '../workout';

export type PlatformId = 'intervals';

/** Whose account a token turns out to belong to. The OAuth exchange says. */
export type Account = { id: string; name: string | null };

/** The sync key is ours and stable, so a push is idempotent even without the `remote_id`. */
export type Outbound = { workout: Workout; syncKey: string };

/**
 * A session the platform says was actually done, named by our remote id.
 *
 * `activity` is the recording behind it, where the platform can name one: it is what
 * `recording` is asked for, so the stats are read without listing the activities again.
 *
 * `comment` is the activity's description upstream. It is carried only so a note of
 * ours can be compared against what is already there and skipped when they agree —
 * never adopted as the athlete's own. See `syncComment`.
 */
export type Completion = {
  remote_id: string;
  completed_at: string;
  activity: Recording | null;
  comment: string | null;
};

/**
 * A workout planned on the platform, in our own shape.
 *
 * The adapter does the translating, as it does on the way out, but the plan is still put
 * through `parseWorkout` before it is stored: one set of rules, whoever wrote it.
 *
 * `external_id` is the key the event carries upstream, which is the workout id we pushed
 * it under when the event is one of ours — and so the first thing that says not to read
 * it back in.
 */
export type PlannedWorkout = {
  remote_id: string;
  external_id: string | null;
  plan: WorkoutInput;
};

/** A session the athlete recorded on the platform, theirs entirely — we never pushed it. */
export type Recorded = {
  /** The platform's id for the recorded session. */
  remote_id: string;
  /** The athlete's local day it was recorded on, `YYYY-MM-DD`. */
  date: string;
  name: string;
  /** The extension of the file the athlete actually uploaded, when the platform says. */
  original_type: string | null;
  /** The platform's own name for the activity, e.g. `TrailRun`. Shown, never matched on. */
  activity_type: string | null;
  /** That placed on our own scale, or null when we cannot place it. See `sportOf`. */
  sport: Sport | null;
  /** Summary figures, for picking sessions out of a list. Null where the platform is silent. */
  distance_m: number | null;
  moving_time_s: number | null;
  /** The activity's description upstream — the platform's text, which may be theirs or an app's. */
  comment: string | null;
};

/** Enough of a recorded session to ask the platform for its file. */
export type Recording = Pick<Recorded, 'remote_id' | 'original_type'>;

/** A recording on its way somewhere else: handed over as a stream, never buffered here. */
export type RecordedFile = {
  body: ReadableStream;
  content_type: string;
  /** Absent when the platform did not say, which costs the reader its streaming path. */
  content_length: number | null;
};

export type Platform = {
  id: PlatformId;
  /** Shown on the dashboard. */
  label: string;
  /** Shown on the dashboard before the athlete connects: what connecting is for. */
  connect_help: string;
  /** Shown on the dashboard once connected: what the platform still needs from the athlete. */
  connected_note?: string;

  /** Create or replace the workout upstream. Returns the platform's own id. */
  push(token: string, outbound: Outbound): Promise<string>;

  /** Remove a workout we previously pushed. Already gone counts as removed. */
  remove(token: string, remoteId: string): Promise<void>;

  /** Sessions the platform has matched to the workouts we pushed, by date. */
  completions(token: string, from: string, to: string): Promise<Completion[]>;

  /**
   * What the athlete has planned on the platform, by date, ours included — telling
   * those apart is the sync layer's job, since only it knows what we pushed.
   *
   * Optional: a platform with no calendar of its own never offers it, and the switch
   * the athlete turns on is only shown where it is offered.
   */
  planned?(token: string, from: string, to: string): Promise<PlannedWorkout[]>;

  /** Hand the token back, so a disconnect here releases the grant there. */
  revoke?(token: string): Promise<void>;

  /**
   * Write the athlete's post-workout comment onto the recorded activity upstream.
   *
   * Optional: a platform with nowhere to put one simply keeps the note here. Null
   * clears it, so "nothing said" has one spelling on both sides.
   */
  setActivityComment?(token: string, activityId: string, comment: string | null): Promise<void>;

  /** Sessions recorded on the platform. Optional: only `src/drive/` asks, and only if offered. */
  activities?(token: string, from: string, to: string): Promise<Recorded[]>;

  /** The FIT recording behind one of those. Required if `activities` is offered. */
  recording?(token: string, recorded: Recording): Promise<RecordedFile>;
};

/** Theirs, not ours: shown on the dashboard, and never allowed to fail a write. */
export class PlatformError extends Error {
  constructor(
    readonly platform: PlatformId,
    message: string,
    /**
     * What they answered with, or null where they never answered at all — a name
     * that would not resolve, a connection that dropped, a body that was not JSON.
     * Read by callers deciding whether asking again could go any differently.
     */
    readonly status: number | null = null,
  ) {
    super(message);
  }
}
