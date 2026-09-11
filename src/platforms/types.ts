/**
 * What a training platform has to be able to do.
 *
 * intervals.icu is the first, but it will not be the only one, so nothing
 * above this line knows anything about it: `src/plan.ts` calls the sync layer,
 * the sync layer walks the registry, and only the adapter in this directory
 * knows what an event or an athlete id is.
 *
 * An adapter is deliberately stateless — it is handed the credential on every
 * call and stores nothing — so the whole of the "which athlete, which row,
 * which error" bookkeeping lives in `store.ts` and `sync.ts` rather than being
 * re-implemented by each platform.
 */

import type { Workout } from '../workout';

export type PlatformId = 'intervals';

/** Whose account a credential turns out to belong to. */
export type Account = { id: string; name: string | null };

/**
 * A workout on its way out, with the key it is upserted under.
 *
 * The key is ours and stable for the life of the workout, so a push is
 * idempotent: re-pushing a workout we have lost the `remote_id` for updates
 * the event already there instead of adding a second copy.
 */
export type Outbound = { workout: Workout; syncKey: string };

/** A session the platform says was actually done, named by our remote id. */
export type Completion = { remote_id: string; completed_at: string };

export type Platform = {
  id: PlatformId;
  /** Shown on the dashboard. */
  label: string;
  /** What the athlete has to paste in, and where they find it. */
  credential: { label: string; help: string; help_url: string };

  /** Prove the credential works, and say whose account it is. Throws if not. */
  verify(key: string): Promise<Account>;

  /** Create or replace the workout upstream. Returns the platform's own id. */
  push(key: string, outbound: Outbound): Promise<string>;

  /** Remove a workout we previously pushed. Already gone counts as removed. */
  remove(key: string, remoteId: string): Promise<void>;

  /** Sessions the platform has matched to the workouts we pushed, by date. */
  completions(key: string, from: string, to: string): Promise<Completion[]>;
};

/**
 * A failure that came from the platform rather than from us.
 *
 * Carried as far as the dashboard, so "your key expired" does not read as an
 * internal error, and never allowed to fail the athlete's own write.
 */
export class PlatformError extends Error {
  constructor(
    readonly platform: PlatformId,
    message: string,
  ) {
    super(message);
  }
}
