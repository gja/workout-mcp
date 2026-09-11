/**
 * D1 storage for the Garmin integration.
 *
 * Three things are remembered: the athlete's connection, a connect flow still
 * in the air, and which Garmin workout each of ours became. The schema is in
 * `migrations/0004_garmin.sql`, which explains the shape; this module is only
 * the queries, and the sealing of the tokens on the way in and out.
 */

import type { Env } from '../db';
import { encryptionSecret, keyId, seal, unseal } from './crypto';
import { CONNECT_STATE_TTL_MINUTES, REFRESH_MARGIN_MS, GarminAuthError, refreshTokens } from './oauth';
import type { GarminTokens } from './oauth';

/** A connection as the app uses it: tokens open, expiries parsed. */
export type Connection = {
  userId: string;
  garminUserId: string | null;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string | null;
  connectedAt: string;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  autoSync: boolean;
};

/** What the dashboard and the tools are told, with no token material in it. */
export type ConnectionStatus = {
  connected: boolean;
  configured: boolean;
  garmin_user_id?: string | null;
  connected_at?: string;
  last_sync_at?: string | null;
  last_sync_error?: string | null;
  auto_sync?: boolean;
  synced_workouts?: number;
};

type ConnectionRow = {
  user_id: string;
  garmin_user_id: string | null;
  access_token: string;
  refresh_token: string;
  key_id: string;
  access_expires_at: string;
  refresh_expires_at: string | null;
  connected_at: string;
  last_sync_at: string | null;
  last_sync_error: string | null;
  auto_sync: number;
};

const iso = (date: Date = new Date()): string => date.toISOString();

function requireSecret(env: Env): string {
  const secret = encryptionSecret(env);
  if (!secret) throw new GarminAuthError('Garmin sync is not configured on this server');
  return secret;
}

// ---------------------------------------------------------------------------
// Connect flows
// ---------------------------------------------------------------------------

/** Remember an in-flight connect flow. Single use, and swept once expired. */
export async function startConnect(
  env: Env,
  userId: string,
  state: string,
  verifier: string,
  returnTo: string | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO garmin_connect_states (state, user_id, code_verifier, return_to, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(state, userId, verifier, returnTo, iso(new Date(Date.now() + CONNECT_STATE_TTL_MINUTES * 60_000)))
    .run();
}

/**
 * Consume a connect state.
 *
 * Deleted whether or not it turns out to be usable, so a callback cannot be
 * replayed against it. The athlete it names is returned alongside the
 * verifier: the callback has to land on the account that started the flow,
 * not merely on whoever happens to be signed in when it comes back.
 */
export async function takeConnectState(
  env: Env,
  state: string,
): Promise<{ userId: string; verifier: string; returnTo: string | null }> {
  const row = await env.DB.prepare(
    'SELECT user_id, code_verifier, return_to, expires_at FROM garmin_connect_states WHERE state = ?',
  )
    .bind(state)
    .first<{ user_id: string; code_verifier: string; return_to: string | null; expires_at: string }>();

  await env.DB.prepare('DELETE FROM garmin_connect_states WHERE state = ?').bind(state).run();

  if (!row || Date.parse(row.expires_at) < Date.now()) {
    throw new GarminAuthError('that Garmin connection link has expired — please start again');
  }
  return { userId: row.user_id, verifier: row.code_verifier, returnTo: row.return_to };
}

/** Sweep abandoned connect attempts. Called by the nightly cron. */
export async function pruneConnectStates(env: Env, now: Date = new Date()): Promise<number> {
  const result = await env.DB.prepare('DELETE FROM garmin_connect_states WHERE expires_at < ?').bind(iso(now)).run();
  return result.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/**
 * Store a fresh token pair, keeping whatever the row already knew that the
 * tokens do not carry — when the athlete connected, and whether the nightly
 * sweep may push for them. A refresh must not silently re-enable auto-sync
 * that the athlete turned off.
 */
export async function saveTokens(
  env: Env,
  userId: string,
  tokens: GarminTokens,
  garminUserId: string | null,
): Promise<void> {
  const secret = requireSecret(env);
  const now = iso();

  await env.DB.prepare(
    `INSERT INTO garmin_connections (
       user_id, garmin_user_id, access_token, refresh_token, key_id,
       access_expires_at, refresh_expires_at, connected_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
     ON CONFLICT (user_id) DO UPDATE SET
       garmin_user_id = COALESCE(excluded.garmin_user_id, garmin_connections.garmin_user_id),
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       key_id = excluded.key_id,
       access_expires_at = excluded.access_expires_at,
       refresh_expires_at = excluded.refresh_expires_at,
       updated_at = excluded.updated_at`,
  )
    .bind(
      userId,
      garminUserId,
      await seal(secret, tokens.accessToken),
      await seal(secret, tokens.refreshToken),
      await keyId(secret),
      tokens.accessExpiresAt,
      tokens.refreshExpiresAt,
      now,
    )
    .run();
}

/**
 * The athlete's connection, tokens opened.
 *
 * A row sealed with a key this deployment no longer has is treated as no
 * connection at all, and reported as one: there is nothing to be done with it
 * but connect again, and pretending it is usable only moves the failure to
 * the first Garmin call.
 */
export async function getConnection(env: Env, userId: string): Promise<Connection | null> {
  const row = await env.DB.prepare(
    `SELECT user_id, garmin_user_id, access_token, refresh_token, key_id, access_expires_at,
            refresh_expires_at, connected_at, last_sync_at, last_sync_error, auto_sync
     FROM garmin_connections WHERE user_id = ?`,
  )
    .bind(userId)
    .first<ConnectionRow>();
  if (!row) return null;

  const secret = encryptionSecret(env);
  if (!secret || row.key_id !== (await keyId(secret))) {
    console.warn(`garmin tokens for ${userId} were sealed with a different key`);
    return null;
  }

  const accessToken = await unseal(secret, row.access_token);
  const refreshToken = await unseal(secret, row.refresh_token);
  if (!accessToken || !refreshToken) {
    console.warn(`garmin tokens for ${userId} would not open`);
    return null;
  }

  return {
    userId: row.user_id,
    garminUserId: row.garmin_user_id,
    accessToken,
    refreshToken,
    accessExpiresAt: row.access_expires_at,
    refreshExpiresAt: row.refresh_expires_at,
    connectedAt: row.connected_at,
    lastSyncAt: row.last_sync_at,
    lastSyncError: row.last_sync_error,
    autoSync: row.auto_sync !== 0,
  };
}

/**
 * A connection with a token that is good for the next few minutes.
 *
 * Refreshing rewrites the stored pair, because Garmin rotates the refresh
 * token on every use: keeping the old one would mean the next refresh fails
 * and the athlete is asked to reconnect for no reason.
 */
export async function withFreshToken(env: Env, connection: Connection, force = false): Promise<Connection> {
  if (!force && Date.parse(connection.accessExpiresAt) - REFRESH_MARGIN_MS > Date.now()) return connection;

  if (connection.refreshExpiresAt && Date.parse(connection.refreshExpiresAt) < Date.now()) {
    throw new GarminAuthError('the Garmin connection has expired — please connect the account again');
  }

  const tokens = await refreshTokens(env, connection.refreshToken);
  await saveTokens(env, connection.userId, tokens, connection.garminUserId);
  return {
    ...connection,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
  };
}

export async function setAutoSync(env: Env, userId: string, enabled: boolean): Promise<void> {
  await env.DB.prepare('UPDATE garmin_connections SET auto_sync = ?, updated_at = ? WHERE user_id = ?')
    .bind(enabled ? 1 : 0, iso(), userId)
    .run();
}

/**
 * How long a claimed sync lock is honoured before another run may take it.
 *
 * A Worker invocation is bounded well under this, so a lock older than it
 * belongs to a run that died rather than to one still working — an isolate
 * evicted mid-flight leaves no chance to release it.
 */
export const SYNC_LOCK_TTL_MS = 5 * 60_000;

/**
 * Claim the right to sync this athlete, or find it already claimed.
 *
 * One conditional UPDATE, which SQLite applies atomically, so exactly one of
 * two concurrent runs sees a changed row and proceeds. See
 * `migrations/0005_garmin_sync_lock.sql` for what goes wrong without it.
 */
export async function claimSync(env: Env, userId: string, now: Date = new Date()): Promise<boolean> {
  const stale = new Date(now.getTime() - SYNC_LOCK_TTL_MS).toISOString();
  const result = await env.DB.prepare(
    `UPDATE garmin_connections SET sync_locked_at = ?1
     WHERE user_id = ?2 AND (sync_locked_at IS NULL OR sync_locked_at < ?3)`,
  )
    .bind(iso(now), userId, stale)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function releaseSync(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('UPDATE garmin_connections SET sync_locked_at = NULL WHERE user_id = ?').bind(userId).run();
}

/**
 * Note that the plan changed and wants pushing.
 *
 * Written before a push is attempted rather than after it fails, so the mark
 * is already there when the push turns out to be refused by the lock. See
 * `migrations/0007_garmin_resync.sql`.
 */
export async function requestResync(env: Env, userId: string, now: Date = new Date()): Promise<void> {
  await env.DB.prepare('UPDATE garmin_connections SET resync_requested_at = ? WHERE user_id = ?')
    .bind(iso(now), userId)
    .run();
}

/**
 * Claim an outstanding resync request newer than `since`, if there is one.
 *
 * Clears it in the same statement it tests, so two runs cannot both decide the
 * request is theirs. A request that arrives after this returns stays for the
 * next run, which is the conservative direction: an extra pass over an
 * unchanged plan costs no Garmin calls, whereas a dropped request costs a
 * workout its place on the calendar.
 */
export async function takeResyncRequest(env: Env, userId: string, since: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE garmin_connections SET resync_requested_at = NULL
     WHERE user_id = ? AND resync_requested_at IS NOT NULL AND resync_requested_at > ?`,
  )
    .bind(userId, since)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function recordSync(env: Env, userId: string, error: string | null): Promise<void> {
  await env.DB.prepare(
    'UPDATE garmin_connections SET last_sync_at = ?1, last_sync_error = ?2, updated_at = ?1 WHERE user_id = ?3',
  )
    .bind(iso(), error, userId)
    .run();
}

/**
 * Forget the connection and every link that depended on it.
 *
 * The links go because they name workouts in an account we can no longer
 * reach: keeping them would make a later reconnection try to update Garmin
 * workouts by ids it has no business holding.
 */
export async function disconnect(env: Env, userId: string): Promise<boolean> {
  await env.DB.prepare('DELETE FROM garmin_workouts WHERE user_id = ?').bind(userId).run();
  const result = await env.DB.prepare('DELETE FROM garmin_connections WHERE user_id = ?').bind(userId).run();
  return (result.meta.changes ?? 0) > 0;
}

/** Athletes the nightly sweep should push for. */
export async function autoSyncUserIds(env: Env, limit: number): Promise<string[]> {
  const { results } = await env.DB.prepare(
    'SELECT user_id FROM garmin_connections WHERE auto_sync = 1 ORDER BY COALESCE(last_sync_at, connected_at) LIMIT ?',
  )
    .bind(limit)
    .all<{ user_id: string }>();
  return (results ?? []).map((row) => row.user_id);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** Which Garmin workout one of ours became, and on what date it is scheduled. */
export type Link = {
  workoutId: string;
  garminWorkoutId: string;
  garminScheduleId: string | null;
  scheduledDate: string;
  fingerprint: string;
  syncedAt: string;
};

type LinkRow = {
  workout_id: string;
  garmin_workout_id: string;
  garmin_schedule_id: string | null;
  scheduled_date: string;
  fingerprint: string;
  synced_at: string;
};

const toLink = (row: LinkRow): Link => ({
  workoutId: row.workout_id,
  garminWorkoutId: row.garmin_workout_id,
  garminScheduleId: row.garmin_schedule_id,
  scheduledDate: row.scheduled_date,
  fingerprint: row.fingerprint,
  syncedAt: row.synced_at,
});

export async function listLinks(env: Env, userId: string): Promise<Link[]> {
  const { results } = await env.DB.prepare(
    `SELECT workout_id, garmin_workout_id, garmin_schedule_id, scheduled_date, fingerprint, synced_at
     FROM garmin_workouts WHERE user_id = ? ORDER BY scheduled_date`,
  )
    .bind(userId)
    .all<LinkRow>();
  return (results ?? []).map(toLink);
}

export async function countLinks(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM garmin_workouts WHERE user_id = ?')
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function saveLink(env: Env, userId: string, link: Omit<Link, 'syncedAt'>): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO garmin_workouts (
       user_id, workout_id, garmin_workout_id, garmin_schedule_id, scheduled_date, fingerprint, synced_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (user_id, workout_id) DO UPDATE SET
       garmin_workout_id = excluded.garmin_workout_id,
       garmin_schedule_id = excluded.garmin_schedule_id,
       scheduled_date = excluded.scheduled_date,
       fingerprint = excluded.fingerprint,
       synced_at = excluded.synced_at`,
  )
    .bind(
      userId,
      link.workoutId,
      link.garminWorkoutId,
      link.garminScheduleId,
      link.scheduledDate,
      link.fingerprint,
      iso(),
    )
    .run();
}

export async function deleteLink(env: Env, userId: string, workoutId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM garmin_workouts WHERE user_id = ? AND workout_id = ?')
    .bind(userId, workoutId)
    .run();
}
