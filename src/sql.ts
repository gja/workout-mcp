// Queries are *built* with Kysely and *run* by D1. See docs/database.md.
//
// Kysely is used as a compiler and nothing else: `SqliteQueryCompiler` emits the
// positional `?` placeholders and ordered parameter array that `D1Database.prepare`
// and `.bind` already want, so there is no driver, no connection pool and no second
// way to reach the database — `all`, `one` and `changes` below are the only three,
// and each one ends in `env.DB.prepare`. A query that Kysely expresses badly stays
// hand-written SQL against the same three helpers; the cross-user sweeps do.
//
// `Schema` is types only. It is erased at build, so it cannot drift into being a
// second source of truth beside `migrations/` the way a runtime schema object would.

import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import type { Compilable, DatabaseConnection, Driver } from 'kysely';
import type { Env } from './db';

// --- The schema ------------------------------------------------------------

type Workouts = {
  user_id: string;
  id: string;
  date: string;
  name: string;
  sport: string;
  sub_sport: string | null;
  notes: string | null;
  /** A JSON array of strings, or null for none. */
  tags: string | null;
  external_id: string | null;
  steps: string;
  completed_at: string | null;
  comment: string | null;
  /** The recorded session, as `src/stats.ts` wrote it, or null until one comes back. */
  stats: string | null;
  /** A JSON array of `{at, reason}`, or null while nothing has been explained. */
  changes: string | null;
  created_at: string;
  updated_at: string;
};

type Users = {
  id: string;
  provider: string;
  subject: string;
  email: string | null;
  /** 0 or 1. Only an address the provider vouches for can link one row to another. */
  email_verified: number;
  /** Null for an account; the account this sign-in was linked to otherwise. */
  alias_of_user_id: string | null;
  created_at: string;
  last_login_at: string | null;
};

type LoginStates = {
  state: string;
  provider: string;
  code_verifier: string | null;
  return_to: string | null;
  /** The athlete a connect-intent flow belongs to; null for a sign-in. */
  user_id: string | null;
  expires_at: string;
};

type Sessions = { id_hash: string; user_id: string; expires_at: string; created_at: string };

type Tokens = {
  token_hash: string;
  user_id: string;
  name: string | null;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
};

type Contexts = { user_id: string; kind: string; markdown: string; created_at: string; updated_at: string };

type PlatformConnections = {
  user_id: string;
  platform: string;
  /** The athlete's token, encrypted — never selected into anything the app hands out. */
  secret: string;
  account: string | null;
  account_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type PlatformLinks = {
  user_id: string;
  platform: string;
  date: string;
  workout_id: string;
  remote_id: string;
  fingerprint: string;
  applied_completion: string | null;
  applied_comment: string | null;
  synced_at: string;
};

type DriveConnections = {
  user_id: string;
  drive_id: string;
  drive_name: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type DriveCopies = {
  user_id: string;
  platform: string;
  remote_id: string;
  path: string;
  /** Null while a claim is in flight; set once the upload lands. */
  file_id: string | null;
  copied_at: string;
};

export type Schema = {
  workouts: Workouts;
  users: Users;
  login_states: LoginStates;
  sessions: Sessions;
  tokens: Tokens;
  contexts: Contexts;
  platform_connections: PlatformConnections;
  platform_links: PlatformLinks;
  drive_connections: DriveConnections;
  drive_copies: DriveCopies;
};

// --- The builder -----------------------------------------------------------

/**
 * Kysely insists on a driver. This one refuses, so `.execute()` — which would otherwise
 * quietly hand back an empty result set and read as "no rows" — fails loudly instead.
 */
class CompileOnlyDriver implements Driver {
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    throw new Error('queries are compiled here and run by D1: use all(), one() or changes()');
  }
  async beginTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

export const qb = new Kysely<Schema>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new CompileOnlyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

// --- Running one -----------------------------------------------------------

/** A built query, or hand-written SQL with its parameters. */
export type Query<O> = Compilable<O> | { sql: string; parameters: readonly unknown[] };

const compile = <O>(query: Query<O>): { sql: string; parameters: readonly unknown[] } =>
  'compile' in query ? query.compile() : query;

const statement = <O>(env: Env, query: Query<O>): D1PreparedStatement => {
  const { sql, parameters } = compile(query);
  return env.DB.prepare(sql).bind(...parameters);
};

export async function all<O>(env: Env, query: Query<O>): Promise<O[]> {
  const { results } = await statement(env, query).all<O>();
  return results ?? [];
}

export async function one<O>(env: Env, query: Query<O>): Promise<O | null> {
  return (await statement(env, query).first<O>()) ?? null;
}

/** A write whose row count nobody asks about. */
export async function run<O>(env: Env, query: Query<O>): Promise<void> {
  await statement(env, query).run();
}

/** Rows written, for the writes whose answer is "did that touch anything". */
export async function changes<O>(env: Env, query: Query<O>): Promise<number> {
  const result = await statement(env, query).run();
  return result.meta.changes ?? 0;
}

/** Several writes, one round trip. Ordered, as `D1Database.batch` is. */
export async function batch(env: Env, queries: ReadonlyArray<Query<unknown>>): Promise<void> {
  await env.DB.batch(queries.map((query) => statement(env, query)));
}
