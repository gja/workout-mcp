// What a training platform has to be able to do. Adapters are stateless — handed
// the athlete's OAuth access token on every call, storing nothing. See docs/architecture.md.

import type { Workout } from '../workout';

export type PlatformId = 'intervals';

/** Whose account a token turns out to belong to. The OAuth exchange says. */
export type Account = { id: string; name: string | null };

/** The sync key is ours and stable, so a push is idempotent even without the `remote_id`. */
export type Outbound = { workout: Workout; syncKey: string };

/** A session the platform says was actually done, named by our remote id. */
export type Completion = { remote_id: string; completed_at: string };

/** A session the athlete recorded on the platform, theirs entirely — we never pushed it. */
export type Recorded = {
  /** The platform's id for the recorded session. */
  remote_id: string;
  /** The athlete's local day it was recorded on, `YYYY-MM-DD`. */
  date: string;
  name: string;
  /** The extension of the file the athlete actually uploaded, when the platform says. */
  original_type: string | null;
};

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
  /** Shown on the dashboard before the athlete connects: what the round will ask them for. */
  connect: { help: string; help_url: string };
  /** Shown on the dashboard once connected: what the platform still needs from the athlete. */
  connected_note?: string;

  /** Create or replace the workout upstream. Returns the platform's own id. */
  push(token: string, outbound: Outbound): Promise<string>;

  /** Remove a workout we previously pushed. Already gone counts as removed. */
  remove(token: string, remoteId: string): Promise<void>;

  /** Sessions the platform has matched to the workouts we pushed, by date. */
  completions(token: string, from: string, to: string): Promise<Completion[]>;

  /** Hand the token back, so a disconnect here releases the grant there. */
  revoke?(token: string): Promise<void>;

  /** Sessions recorded on the platform. Optional: only `src/drive/` asks, and only if offered. */
  activities?(token: string, from: string, to: string): Promise<Recorded[]>;

  /** The FIT recording behind one of those. Required if `activities` is offered. */
  recording?(token: string, recorded: Recorded): Promise<RecordedFile>;
};

/** Theirs, not ours: shown on the dashboard, and never allowed to fail a write. */
export class PlatformError extends Error {
  constructor(
    readonly platform: PlatformId,
    message: string,
  ) {
    super(message);
  }
}
