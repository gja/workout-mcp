/**
 * Garmin, as the rest of the app sees it.
 *
 * One object satisfying `WorkoutProvider`, which is the whole surface
 * `src/sync.ts` is allowed to know about. Everything else in this directory —
 * the OAuth flow, the sealed tokens, the Training API, the payload mapping,
 * the link table — is behind it.
 *
 * The point of the seam is that adding Coros is a sibling of this file plus a
 * line in `src/sync.ts`, and no write path, tool or route changes.
 */

import type { Env } from '../db';
import type { SyncOptions, SyncReport, WorkoutProvider } from '../sync';
import { isConfigured } from './oauth';
import * as store from './store';
import { syncAll } from './sync';

export const garminProvider: WorkoutProvider = {
  name: 'garmin',
  label: 'Garmin Connect',

  isConfigured: (env: Env) => isConfigured(env),

  // A connection whose tokens will not open counts as absent, which is what
  // `getConnection` already decides — there is nothing to be done with one but
  // connect again.
  isConnected: async (env: Env, userId: string) => (await store.getConnection(env, userId)) !== null,

  sync: (env: Env, userId: string, options?: SyncOptions): Promise<SyncReport> => syncAll(env, userId, options),

  scheduledUserIds: (env: Env, limit: number) => store.autoSyncUserIds(env, limit),

  connectPath: () => '/garmin/connect',
};
