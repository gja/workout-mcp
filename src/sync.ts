/**
 * Publishing the plan to wherever the athlete keeps it.
 *
 * Garmin is the first destination, not the only one — Coros and the rest work
 * the same way: an athlete connects an account, planned workouts are pushed to
 * it, and what they actually recorded comes back. So the vocabulary of a sync
 * lives here rather than inside any one provider, and the rest of the app
 * talks to this module: a write calls `syncWorkouts`, the nightly cron calls
 * `syncEveryone`, and neither names a provider.
 *
 * A provider owns everything below that line — its OAuth, its storage, its
 * payload mapping, its idea of a calendar entry — and none of it leaks up
 * here. Adding one is a module under `src/<provider>/` plus an entry in
 * `PROVIDERS`; no write path changes.
 *
 * What is deliberately *not* generalised is connecting an account. Every
 * provider's consent flow, token shape and settings differ, and pretending
 * otherwise buys nothing: `/api/garmin/*` stays Garmin's own, and a future
 * `/api/coros/*` will be its own too.
 */

import type { Env } from './db';

// ---------------------------------------------------------------------------
// The vocabulary of a sync
// ---------------------------------------------------------------------------

/**
 * Somewhere to put work that should outlive the response.
 *
 * `ExecutionContext` satisfies this. Named rather than imported so the tool
 * and HTTP layers can say "this write should be followed by a sync" without
 * taking a dependency on the Workers runtime shape.
 */
export type Background = { waitUntil(work: Promise<unknown>): void };

/**
 * The most calls one *Worker invocation* may make to all providers together.
 *
 * A Worker gets a bounded number of outbound subrequests per invocation — 50
 * on the free plan this app is built to fit — so the budget belongs to the
 * invocation, not to the athlete and not to the provider. A run does what it
 * can within it and says how much is left, rather than dying partway through
 * with no report.
 */
export const MAX_CALLS_PER_RUN = 30;

/** How many athletes the nightly sweep will look at, budget permitting. */
export const MAX_USERS_PER_SWEEP = 5;

/** A call budget, shared by everything spending from one invocation. */
export type Budget = { remaining: number };

export const newBudget = (limit = MAX_CALLS_PER_RUN): Budget => ({ remaining: limit });

/** What a sync did with one workout. */
export type SyncAction =
  | 'created'
  | 'updated'
  | 'rescheduled'
  | 'unchanged'
  | 'removed'
  | 'untracked'
  | 'skipped'
  | 'failed';

export type SyncEntry = {
  date: string;
  id: string;
  name?: string;
  action: SyncAction;
  /** The provider's own id for the workout, whatever it calls that. */
  remote_workout_id?: string;
  /** The provider's own id for the calendar entry. */
  remote_schedule_id?: string;
  /** What the provider could not carry. */
  notes?: string[];
  error?: string;
  /** On a dry run, exactly what would have been sent. */
  payload?: unknown;
};

/** A session the provider says the athlete did, and what says so. */
export type CompletedEntry = {
  date: string;
  id: string;
  name?: string;
  /** ISO instant, taken from when the activity started. */
  completed_at: string;
  activity: string;
};

export type SyncReport = {
  dry_run: boolean;
  /** Set when the call budget ran out; run again to finish. */
  truncated: boolean;
  counts: Record<SyncAction, number>;
  workouts: SyncEntry[];
  /** Sessions ticked off from what the athlete recorded. */
  completed: CompletedEntry[];
  /** Why the completion pull did not run, or did not run in full. */
  completed_note?: string;
  /** A failure that stopped the run rather than one workout. */
  error?: string;
};

export const emptyCounts = (): Record<SyncAction, number> => ({
  created: 0,
  updated: 0,
  rescheduled: 0,
  unchanged: 0,
  removed: 0,
  untracked: 0,
  skipped: 0,
  failed: 0,
});

export const emptyReport = (dryRun: boolean): SyncReport => ({
  dry_run: dryRun,
  truncated: false,
  counts: emptyCounts(),
  workouts: [],
  completed: [],
});

export type SyncOptions = {
  /** Build and diff everything, call nothing, and show what would be sent. */
  dryRun?: boolean;
  /** Push every workout again even where nothing appears to have changed. */
  force?: boolean;
  /** A budget to spend from, for a caller syncing several athletes at once. */
  budget?: Budget;
};

/**
 * A sync that could not start because one is already running.
 *
 * Reported rather than queued: the run already going will push whatever this
 * one would have, so the useful answer is "it is happening" and not a second
 * pass over the same diff.
 */
export class SyncBusyError extends Error {
  constructor(provider: string) {
    super(`a ${provider} sync is already running for this account — give it a moment and check again`);
  }
}

/**
 * A sync that cannot run because the athlete has not connected an account, or
 * the connection has lapsed. Theirs to fix, by connecting again.
 */
export class NotConnectedError extends Error {}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** One place an athlete's plan can be published to. */
export type WorkoutProvider = {
  /** Stable key, used in reports, logs and URLs. */
  readonly name: string;
  /** Human-readable, for a message an athlete reads. */
  readonly label: string;
  /** Whether this deployment has credentials for it at all. */
  isConfigured(env: Env): boolean;
  /** Whether this athlete has actually connected it. */
  isConnected(env: Env, userId: string): Promise<boolean>;
  /**
   * Reconcile one athlete's plan with the provider.
   *
   * Throws only when the run could not start — `NotConnectedError` or
   * `SyncBusyError`. Anything that goes wrong once it has started belongs in
   * the report, so one refused workout does not hide the rest.
   */
  sync(env: Env, userId: string, options?: SyncOptions): Promise<SyncReport>;
  /** Athletes who asked to be synced on a schedule, oldest sync first. */
  scheduledUserIds(env: Env, limit: number): Promise<string[]>;
  /** Where to send an athlete who has not connected yet. */
  connectPath(): string;
};

/**
 * Every provider this app knows how to publish to.
 *
 * Registered here rather than discovered, so the set is readable in one place
 * and the order is ours. Import inside the accessor to keep the module graph
 * acyclic: a provider imports this module for its vocabulary.
 */
async function providers(): Promise<WorkoutProvider[]> {
  const { garminProvider } = await import('./garmin/provider');
  return [garminProvider];
}

/** Those a deployment has credentials for. */
export const configuredProviders = async (env: Env): Promise<WorkoutProvider[]> =>
  (await providers()).filter((provider) => provider.isConfigured(env));

// ---------------------------------------------------------------------------
// Syncing
// ---------------------------------------------------------------------------

/** One provider's outcome, for a caller that asked about all of them. */
export type ProviderOutcome =
  | { provider: string; label: string; connected: true; report: SyncReport }
  | { provider: string; label: string; connected: false; connect_url?: string; note: string };

/**
 * Sync one athlete's plan to every provider they have connected.
 *
 * `origin` is only used to say where to connect a provider that is configured
 * but unconnected — a page the athlete is meant to open, which is the one sort
 * of URL worth handing back.
 */
export async function syncNow(
  env: Env,
  userId: string,
  options: SyncOptions = {},
  origin?: string,
): Promise<{ providers: ProviderOutcome[] }> {
  const available = await configuredProviders(env);
  const outcomes: ProviderOutcome[] = [];

  // One budget across all of them, because the subrequest limit is per
  // invocation. Whoever is first in `PROVIDERS` gets the room.
  const budget = options.budget ?? newBudget();

  for (const provider of available) {
    const head = { provider: provider.name, label: provider.label };
    if (!(await provider.isConnected(env, userId))) {
      outcomes.push({
        ...head,
        connected: false,
        ...(origin ? { connect_url: `${origin}${provider.connectPath()}` } : {}),
        note:
          `No ${provider.label} account is linked. Linking one needs their consent screen in a browser, ` +
          'so it is a one-time step the athlete does themselves; there is nothing to paste back.',
      });
      continue;
    }
    outcomes.push({ ...head, connected: true, report: await provider.sync(env, userId, { ...options, budget }) });
  }

  return { providers: outcomes };
}

/**
 * Sync after a write, without the write waiting for it.
 *
 * Creating a workout should put it on the watch — that is the point of having
 * connected an account at all, and asking the athlete to press Sync afterwards
 * makes it something they have to remember. So every write schedules one.
 *
 * It runs in `waitUntil`, so the response has already gone: a provider being
 * down cannot fail, slow, or error a write that is already committed. And it
 * is silent — the athlete asked to save a workout, not to hear about Garmin.
 * Whatever went wrong is on the connection for the dashboard to show.
 */
export function syncWorkouts(env: Env, userId: string, background?: Background): void {
  if (!background) return;
  background.waitUntil(syncQuietly(env, userId));
}

async function syncQuietly(env: Env, userId: string): Promise<void> {
  for (const provider of await configuredProviders(env)) {
    try {
      await provider.sync(env, userId);
    } catch (error) {
      // Busy: the run holding the lock will pick up what this write added.
      // Not connected: nothing to do, and not a fault here.
      if (error instanceof SyncBusyError || error instanceof NotConnectedError) continue;
      console.error(`${provider.name} sync after write failed for ${userId}`, error);
    }
  }
}

/**
 * The nightly sweep: sync for every athlete who asked to be synced.
 *
 * Bounded, and ordered by how long it has been since each was last synced, so
 * a deployment with more connected athletes than one run can serve works
 * through them over successive nights instead of always starting at the same
 * end of the list.
 */
export async function syncEveryone(
  env: Env,
): Promise<{ users: number; pushed: number; completed: number; failed: number; budgetSpent: boolean }> {
  const budget = newBudget();
  const seen = new Set<string>();
  let pushed = 0;
  let completed = 0;
  let failed = 0;

  for (const provider of await configuredProviders(env)) {
    for (const userId of await provider.scheduledUserIds(env, MAX_USERS_PER_SWEEP)) {
      // Enough to create and schedule one workout, which is the least a turn
      // is worth taking. Below it the rest are left untouched rather than
      // half-served; they sort first tomorrow.
      if (budget.remaining < 2) break;
      seen.add(userId);

      try {
        const report = await provider.sync(env, userId, { budget });
        pushed +=
          report.counts.created + report.counts.updated + report.counts.rescheduled + report.counts.removed;
        completed += report.completed.length;
        failed += report.counts.failed;
      } catch (error) {
        // One athlete's lapsed connection must not stop the sweep for the
        // rest, and a busy athlete is not a failure — someone is syncing them.
        if (error instanceof SyncBusyError) continue;
        console.error(`nightly ${provider.name} sync failed for ${userId}`, error);
        failed++;
      }
    }
  }

  return { users: seen.size, pushed, completed, failed, budgetSpent: budget.remaining < 2 };
}
