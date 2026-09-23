// Platform connections and the links to what we pushed. The credential is
// encrypted rather than hashed, because it has to be replayed: see docs/integrations.md.

import { retentionWindow } from '../db';
import type { Env } from '../db';
import { all, batch, changes, one, qb, run } from '../sql';
import type { Account, PlatformId } from './types';

/** Connection state as the rest of the app sees it: never the token. */
export type Connection = {
  platform: PlatformId;
  account: string | null;
  last_error: string | null;
  /** Whether what is planned on the platform is copied in. Off unless they asked. */
  import_plan: boolean;
  created_at: string;
  updated_at: string;
};

/** A connection ready to be worked, as the scheduled passes take them. */
export type Usable = { user_id: string; token: string | null; import_plan: boolean };

export class CredentialsUnavailable extends Error {
  constructor() {
    super('platform connections are not configured: set the CREDENTIALS_SECRET binding on the Worker');
  }
}

export const credentialsConfigured = (env: Env): boolean => Boolean(env.CREDENTIALS_SECRET);

const IV_BYTES = 12;

async function aesKey(env: Env): Promise<CryptoKey> {
  if (!env.CREDENTIALS_SECRET) throw new CredentialsUnavailable();
  // The secret is a passphrase of any length; SHA-256 makes it the 32 bytes AES-256 wants.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.CREDENTIALS_SECRET));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const fromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

export async function encryptSecret(env: Env, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await aesKey(env),
    new TextEncoder().encode(plaintext),
  );
  return toBase64(new Uint8Array([...iv, ...new Uint8Array(sealed)]));
}

// Never throws: a rotated secret costs a connection, not every write from then on.
export async function decryptSecret(env: Env, stored: string): Promise<string | null> {
  try {
    const bytes = fromBase64(stored);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES) },
      await aesKey(env),
      bytes.slice(IV_BYTES),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

// --- Connections -----------------------------------------------------------

const CONNECTION_COLUMNS = ['platform', 'account', 'last_error', 'import_plan', 'created_at', 'updated_at'] as const;

/** Re-authorizing replaces the token, so a fresh grant lands on the same row. */
export async function saveConnection(
  env: Env,
  userId: string,
  platform: PlatformId,
  token: string,
  account: Account,
): Promise<void> {
  const now = new Date().toISOString();
  await run(
    env,
    qb
      .insertInto('platform_connections')
      .values({
        user_id: userId,
        platform,
        secret: await encryptSecret(env, token),
        account: account.name ?? account.id,
        account_id: account.id,
        last_error: null,
        import_plan: 0,
        created_at: now,
        updated_at: now,
      })
      // A fresh grant clears the last failure: it was the old token's. `import_plan` is
      // left out of the update on purpose — reconnecting renews a token, and is not a
      // withdrawal of what the athlete asked this connection to do.
      .onConflict((clash) =>
        clash.columns(['user_id', 'platform']).doUpdateSet((eb) => ({
          secret: eb.ref('excluded.secret'),
          account: eb.ref('excluded.account'),
          account_id: eb.ref('excluded.account_id'),
          last_error: null,
          updated_at: eb.ref('excluded.updated_at'),
        })),
      ),
  );
}

export async function listConnections(env: Env, userId: string): Promise<Connection[]> {
  const rows = await all(
    env,
    qb
      .selectFrom('platform_connections')
      .select([...CONNECTION_COLUMNS])
      .where('user_id', '=', userId)
      .orderBy('platform'),
  );
  return rows.map((row) => ({ ...row, platform: row.platform as PlatformId, import_plan: row.import_plan === 1 }));
}

/** Whether what is planned on the platform is copied in. False where nothing was updated. */
export async function setImportPlan(
  env: Env,
  userId: string,
  platform: PlatformId,
  enabled: boolean,
): Promise<boolean> {
  const written = await changes(
    env,
    qb
      .updateTable('platform_connections')
      .set({ import_plan: enabled ? 1 : 0, updated_at: new Date().toISOString() })
      .where('user_id', '=', userId)
      .where('platform', '=', platform),
  );
  return written > 0;
}

/** Least recently visited first, which is what makes consecutive sweeps work round. */
export async function connectionBatch(env: Env, platform: PlatformId, limit: number): Promise<Usable[]> {
  const rows = await all(
    env,
    qb
      .selectFrom('platform_connections')
      .select(['user_id', 'secret', 'import_plan'])
      .where('platform', '=', platform)
      .orderBy('updated_at')
      .limit(limit),
  );

  return Promise.all(
    rows.map(async (row) => ({
      user_id: row.user_id,
      token: await decryptSecret(env, row.secret),
      import_plan: row.import_plan === 1,
    })),
  );
}

/**
 * Deliberately more than one: signing in with intervals.icu makes its own account here,
 * so the same athlete can legitimately be connected to two users and an event concerns
 * all of them.
 */
export async function connectionsForAccount(
  env: Env,
  platform: PlatformId,
  accountId: string,
): Promise<Array<{ user_id: string; token: string | null }>> {
  const rows = await all(
    env,
    qb
      .selectFrom('platform_connections')
      .select(['user_id', 'secret'])
      .where('platform', '=', platform)
      .where('account_id', '=', accountId),
  );

  return Promise.all(
    rows.map(async (row) => ({ user_id: row.user_id, token: await decryptSecret(env, row.secret) })),
  );
}

/**
 * Revoking upstream releases the grant for the *app*, not one token of it, so handing it
 * back on one disconnect would silently 401 an athlete connected to two users.
 */
export async function accountSharedWithOthers(
  env: Env,
  userId: string,
  platform: PlatformId,
): Promise<boolean> {
  // Hand-written: the correlated subquery reads better as the SQL it is.
  const row = await one<{ others: number }>(env, {
    sql: `SELECT COUNT(*) AS others FROM platform_connections
          WHERE platform = ?1 AND user_id <> ?2 AND account_id IS NOT NULL
            AND account_id = (SELECT account_id FROM platform_connections WHERE user_id = ?2 AND platform = ?1)`,
    parameters: [platform, userId],
  });
  return (row?.others ?? 0) > 0;
}

/** The token in the clear, or null when there is no usable connection. */
export async function credentialFor(env: Env, userId: string, platform: PlatformId): Promise<string | null> {
  const row = await one(
    env,
    qb
      .selectFrom('platform_connections')
      .select('secret')
      .where('user_id', '=', userId)
      .where('platform', '=', platform),
  );
  return row ? decryptSecret(env, row.secret) : null;
}

/** Whether this connection copies in what is planned on the platform. */
export async function importsPlanned(env: Env, userId: string, platform: PlatformId): Promise<boolean> {
  const row = await one(
    env,
    qb
      .selectFrom('platform_connections')
      .select('import_plan')
      .where('user_id', '=', userId)
      .where('platform', '=', platform),
  );
  return row?.import_plan === 1;
}

/** Connections with their tokens already decrypted; unreadable ones drop out. */
export async function usableConnections(
  env: Env,
  userId: string,
): Promise<Array<{ platform: PlatformId; token: string }>> {
  const results = await all(
    env,
    qb
      .selectFrom('platform_connections')
      .select(['platform', 'secret'])
      .where('user_id', '=', userId)
      .orderBy('platform'),
  );

  const usable: Array<{ platform: PlatformId; token: string }> = [];
  for (const row of results as Array<{ platform: PlatformId; secret: string }>) {
    const token = await decryptSecret(env, row.secret);
    if (token) usable.push({ platform: row.platform, token });
  }
  return usable;
}

export async function recordSyncError(
  env: Env,
  userId: string,
  platform: PlatformId,
  message: string | null,
): Promise<void> {
  await run(
    env,
    qb
      .updateTable('platform_connections')
      .set({ last_error: message, updated_at: new Date().toISOString() })
      .where('user_id', '=', userId)
      .where('platform', '=', platform),
  );
}

/** Forget the connection and everything we had pushed under it. */
export async function forgetConnection(env: Env, userId: string, platform: PlatformId): Promise<boolean> {
  const written = await changes(
    env,
    qb.deleteFrom('platform_connections').where('user_id', '=', userId).where('platform', '=', platform),
  );
  await run(env, qb.deleteFrom('platform_links').where('user_id', '=', userId).where('platform', '=', platform));
  return written > 0;
}

// --- Links -----------------------------------------------------------------

/** Which side the event behind a link came from. See the migration. */
export type LinkSource = 'local' | 'platform';

export type Link = {
  date: string;
  workout_id: string;
  remote_id: string;
  /** `platform` where the workout was copied off their calendar rather than pushed to it. */
  source: LinkSource;
  /** A digest of the plan as it was last pushed. See the migration. */
  fingerprint: string;
  /** The completion already read back off the platform and applied. */
  applied_completion: string | null;
  /** The post-workout note already handed to the platform. See the migration. */
  applied_comment: string | null;
  synced_at: string;
};

const LINK_COLUMNS = [
  'date',
  'workout_id',
  'remote_id',
  'fingerprint',
  'applied_completion',
  'applied_comment',
  'source',
  'synced_at',
] as const;

/** Every link read and every link write starts scoped to one athlete's platform. */
const scopedLinks = (userId: string, platform: PlatformId) =>
  qb
    .selectFrom('platform_links')
    .select([...LINK_COLUMNS])
    .where('user_id', '=', userId)
    .where('platform', '=', platform)
    // `source` is a column of two spellings, which the schema knows only as TEXT.
    .$castTo<Link>();

/** Leaves the applied columns alone: re-pushing the plan neither changes nor un-does them. */
export async function saveLink(
  env: Env,
  userId: string,
  platform: PlatformId,
  date: string,
  workoutId: string,
  remoteId: string,
  fingerprint: string,
  source: LinkSource = 'local',
): Promise<void> {
  await run(
    env,
    qb
      .insertInto('platform_links')
      .values({
        user_id: userId,
        platform,
        date,
        workout_id: workoutId,
        remote_id: remoteId,
        fingerprint,
        applied_completion: null,
        applied_comment: null,
        source,
        synced_at: new Date().toISOString(),
      })
      .onConflict((clash) =>
        clash.columns(['user_id', 'platform', 'date', 'workout_id']).doUpdateSet((eb) => ({
          remote_id: eb.ref('excluded.remote_id'),
          fingerprint: eb.ref('excluded.fingerprint'),
          source: eb.ref('excluded.source'),
          synced_at: eb.ref('excluded.synced_at'),
        })),
      ),
  );
}

export async function findLink(
  env: Env,
  userId: string,
  platform: PlatformId,
  date: string,
  workoutId: string,
): Promise<Link | null> {
  return one(env, scopedLinks(userId, platform).where('date', '=', date).where('workout_id', '=', workoutId));
}

/** Every link for a platform, keyed `date/workout_id`, for deciding what is stale. */
export async function listLinks(env: Env, userId: string, platform: PlatformId): Promise<Map<string, Link>> {
  const links = await all(env, scopedLinks(userId, platform));
  return new Map(links.map((link) => [`${link.date}/${link.workout_id}`, link]));
}

/** The workout a remote id belongs to, for a completion coming back. */
export async function findLinkByRemoteId(
  env: Env,
  userId: string,
  platform: PlatformId,
  remoteId: string,
): Promise<Link | null> {
  return one(env, scopedLinks(userId, platform).where('remote_id', '=', remoteId));
}

export async function dropLink(
  env: Env,
  userId: string,
  platform: PlatformId,
  date: string,
  workoutId: string,
): Promise<void> {
  await run(
    env,
    qb
      .deleteFrom('platform_links')
      .where('user_id', '=', userId)
      .where('platform', '=', platform)
      .where('date', '=', date)
      .where('workout_id', '=', workoutId),
  );
}

// A moved workout keeps its remote event. The delete comes first, in the same batch:
// the key moved onto may already hold a link, which the update alone would collide with.
export async function moveLinks(
  env: Env,
  userId: string,
  from: { date: string; id: string },
  to: { date: string; id: string },
): Promise<void> {
  await batch(env, [
    qb
      .deleteFrom('platform_links')
      .where('user_id', '=', userId)
      .where('date', '=', to.date)
      .where('workout_id', '=', to.id),
    qb
      .updateTable('platform_links')
      .set({ date: to.date, workout_id: to.id })
      .where('user_id', '=', userId)
      .where('date', '=', from.date)
      .where('workout_id', '=', from.id),
  ]);
}

/** Remember the completion just read back, so it is never applied twice. */
export async function recordAppliedCompletion(
  env: Env,
  userId: string,
  platform: PlatformId,
  date: string,
  workoutId: string,
  completedAt: string,
): Promise<void> {
  await run(
    env,
    qb
      .updateTable('platform_links')
      .set({ applied_completion: completedAt })
      .where('user_id', '=', userId)
      .where('platform', '=', platform)
      .where('date', '=', date)
      .where('workout_id', '=', workoutId),
  );
}

/** Remember the note just handed over, so one note costs one attempt. See the migration. */
export async function recordAppliedComment(
  env: Env,
  userId: string,
  platform: PlatformId,
  date: string,
  workoutId: string,
  comment: string,
): Promise<void> {
  await run(
    env,
    qb
      .updateTable('platform_links')
      .set({ applied_comment: comment })
      .where('user_id', '=', userId)
      .where('platform', '=', platform)
      .where('date', '=', date)
      .where('workout_id', '=', workoutId),
  );
}

/** What the dashboard reports: everything tracked, and how much of it came from there. */
export async function countLinks(
  env: Env,
  userId: string,
  platform: PlatformId,
): Promise<{ synced: number; imported: number }> {
  const row = await one(
    env,
    qb
      .selectFrom('platform_links')
      .select((eb) => [
        eb.fn.countAll<number>().as('n'),
        // One read rather than two: the same rows, counted twice over.
        eb.fn.count<number>(eb.case().when('source', '=', 'platform').then(1).end()).as('inbound'),
      ])
      .where('user_id', '=', userId)
      .where('platform', '=', platform),
  );
  return { synced: row?.n ?? 0, imported: row?.inbound ?? 0 };
}

// Outside the window only: inside it, a link with no workout is a delete `syncNow` still owes.
export async function pruneOrphanedLinks(env: Env, now: Date = new Date()): Promise<number> {
  const { from, to } = retentionWindow(now);
  // Hand-written, and across every athlete: this is the nightly sweep, not a scoped read.
  return changes(env, {
    sql: `DELETE FROM platform_links WHERE (date < ? OR date > ?) AND NOT EXISTS (
            SELECT 1 FROM workouts
            WHERE workouts.user_id = platform_links.user_id
              AND workouts.date = platform_links.date
              AND workouts.id = platform_links.workout_id
          )`,
    parameters: [from, to],
  });
}
