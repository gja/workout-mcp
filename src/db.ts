// D1 storage, the retention window and the per-athlete cap. See docs/database.md.

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { sql } from 'kysely';
import { all, changes as rowsWritten, one, qb, run } from './sql';
import { sessionOnly } from './stats';
import type { StatsSummary, WorkoutStats } from './stats';
import { fail, shiftDate, today } from './units';
import { MAX_CHANGES } from './workout';
import type { PlanChange, PlanStep, Sport, SubSport, Workout, WorkoutInput } from './workout';

export const RETENTION_DAYS_PAST = 7;
export const RETENTION_DAYS_FUTURE = 14;
export const MAX_WORKOUTS_PER_USER = 50;

/** Reads only: dates are the athlete's local day, the window is UTC, so the edges disagree. */
export const READ_SLACK_DAYS = 1;

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Where the OAuth provider keeps clients, grants and their tokens. */
  OAUTH_KV: KVNamespace;
  /** Injected by the OAuth provider on every request it passes through. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Shown on the dashboard and the consent page. */
  APP_NAME?: string;

  /** Google sign-in. Both are needed for the button to appear. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  /** Sign in with Apple. All four are needed for the button to appear. */
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  /** The .p8 private key, base64 PKCS#8, with or without its PEM armour. */
  APPLE_PRIVATE_KEY?: string;
  /** The iOS app's bundle id. Only the native sign-in needs it; see docs/auth.md. */
  APPLE_APP_ID?: string;

  /** Any passphrase. Without it, connecting a training platform is refused outright. */
  CREDENTIALS_SECRET?: string;

  /** The intervals.icu OAuth app. Both are needed for sign-in, and for connecting without a key. */
  INTERVALS_CLIENT_ID?: string;
  INTERVALS_CLIENT_SECRET?: string;
  /** The secret intervals.icu puts in the body of every webhook it sends. Without it, none are accepted. */
  INTERVALS_WEBHOOK_SECRET?: string;
  /** The `Authorization` header configured on their end, when one is. Checked as well as the secret. */
  INTERVALS_WEBHOOK_AUTHORIZATION?: string;

  /** The Google service account the scheduled copier uploads as. Both are needed, or it does nothing. */
  GOOGLE_DRIVE_CLIENT_EMAIL?: string;
  /** Its private key, PEM PKCS#8, straight out of the JSON Google downloads. */
  GOOGLE_DRIVE_PRIVATE_KEY?: string;
};

export type User = { id: string; email: string | null };

type WorkoutRow = {
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
  /** The athlete's note on how it went, or null until they write one. */
  comment: string | null;
  /** The recorded session's stats, as `src/stats.ts` wrote them, or null until one comes back. */
  stats: string | null;
  /** A JSON array of `{at, reason}`, or null while nothing has been explained. */
  changes: string | null;
  updated_at: string;
};

/** The laps are dropped in SQL, not after parsing: they are the bulk of the stats and only `getStats` wants them. */
const WORKOUT_COLUMNS = [
  'id',
  'date',
  'name',
  'sport',
  'sub_sport',
  'notes',
  'tags',
  'external_id',
  'steps',
  'completed_at',
  'comment',
  'changes',
  'updated_at',
] as const;

/**
 * Every workout read starts here: the athlete and the read window are already applied,
 * and a caller adds what it wants on top. Kysely builders are immutable, so narrowing
 * one leaves this untouched, and an `and` is the only thing a caller can add — no read
 * reaches outside the window by forgetting to say so.
 */
function scopedWorkouts(userId: string, range: { from: string; to: string }) {
  return qb
    .selectFrom('workouts')
    .select([...WORKOUT_COLUMNS])
    .select(sql<string | null>`json_remove(stats, '$.laps')`.as('stats'))
    .where('user_id', '=', userId)
    .where('date', '>=', range.from)
    .where('date', '<=', range.to);
}

/** Short, URL-safe, unambiguous — no vowels, so no accidental words. */
const ID_ALPHABET = '0123456789bcdfghjkmnpqrstvwxyz';

export function newId(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

export function retentionWindow(now: Date = new Date()): { from: string; to: string } {
  const day = today(now);
  return { from: shiftDate(day, -RETENTION_DAYS_PAST), to: shiftDate(day, RETENTION_DAYS_FUTURE) };
}

// Every read goes through this. Nothing deletes, so this is the whole of the window.
export function readWindow(now: Date = new Date()): { from: string; to: string } {
  const day = today(now);
  return {
    from: shiftDate(day, -(RETENTION_DAYS_PAST + READ_SLACK_DAYS)),
    to: shiftDate(day, RETENTION_DAYS_FUTURE + READ_SLACK_DAYS),
  };
}

// --- Workouts --------------------------------------------------------------

function parseRow(row: WorkoutRow): Workout {
  const workout: Workout = {
    id: row.id,
    date: row.date,
    name: row.name,
    sport: row.sport as Sport,
    steps: JSON.parse(row.steps) as PlanStep[],
    updated_at: row.updated_at,
  };
  if (row.sub_sport) workout.sub_sport = row.sub_sport as SubSport;
  if (row.notes) workout.notes = row.notes;
  if (row.tags) {
    const tags = JSON.parse(row.tags) as string[];
    if (tags.length > 0) workout.tags = tags;
  }
  if (row.external_id) workout.external_id = row.external_id;
  if (row.completed_at) workout.completed_at = row.completed_at;
  if (row.comment) workout.comment = row.comment;
  if (row.stats) workout.stats = JSON.parse(row.stats) as StatsSummary;
  if (row.changes) {
    const changes = JSON.parse(row.changes) as PlanChange[];
    if (changes.length > 0) workout.changes = changes;
  }
  return workout;
}

/**
 * The write counterpart of `scopedWorkouts`: one workout, inside the read window. A
 * setter adds its own `.set(...)` and nothing else, so none of them can reach a row a
 * read could not have returned in the first place.
 */
function scopedUpdate(userId: string, id: string) {
  const window = readWindow();
  return qb
    .updateTable('workouts')
    .where('user_id', '=', userId)
    .where('id', '=', id)
    .where('date', '>=', window.from)
    .where('date', '<=', window.to);
}

/** A caller's range, narrowed to what a read is allowed to see. */
function readRange(from?: string, to?: string): { from: string; to: string } {
  const window = readWindow();
  return {
    from: from && from > window.from ? from : window.from,
    to: to && to < window.to ? to : window.to,
  };
}

export async function listWorkouts(env: Env, userId: string, from?: string, to?: string): Promise<Workout[]> {
  const rows = await all(env, scopedWorkouts(userId, readRange(from, to)).orderBy('date').orderBy('created_at'));
  return rows.map(parseRow);
}

/** By id alone: the day a workout sits on is not part of what it is. See docs/database.md. */
export async function getWorkout(env: Env, userId: string, id: string): Promise<Workout | null> {
  const row = await one(env, scopedWorkouts(userId, readWindow()).where('id', '=', id));
  return row ? parseRow(row) : null;
}

/**
 * Several workouts in one read — a round trip a workout is what `/api/workout-plans`
 * exists to stop being. Bound one id a key, which fits: D1 takes at most 100 bound
 * parameters and an account holds fifty workouts.
 */
export async function getWorkouts(env: Env, userId: string, ids: readonly string[]): Promise<Workout[]> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];

  const rows = await all(
    env,
    scopedWorkouts(userId, readWindow()).where('id', 'in', wanted).orderBy('date').orderBy('created_at'),
  );
  return rows.map(parseRow);
}

// Not narrowed to the read window: the key's unique index is not either.
export async function findByExternalId(
  env: Env,
  userId: string,
  externalId: string,
): Promise<{ date: string; id: string } | null> {
  return one(
    env,
    qb
      .selectFrom('workouts')
      .select(['date', 'id'])
      .where('user_id', '=', userId)
      .where('external_id', '=', externalId),
  );
}

/** Asked before a write, so a day nothing could be read back from is refused rather than stored. */
export function assertRetainable(date: string): void {
  const window = retentionWindow();
  if (date < window.from || date > window.to) {
    fail('date', `only ${window.from} to ${window.to} is kept, so a workout on ${date} could not be read back`);
  }
}

// Counted inside the window, not over the table, so the cap rolls rather than fills up.
async function assertRoomFor(env: Env, userId: string, date: string): Promise<void> {
  if ((await countInWindow(env, userId)) < MAX_WORKOUTS_PER_USER) return;
  fail(
    'date',
    `only ${MAX_WORKOUTS_PER_USER} workouts are kept at a time, so ${date} would not fit; delete one first`,
  );
}

/** What a rewrite has to carry across rather than overwrite, plus the plan it is judged against. */
type StoredRecord = {
  completed_at: string | null;
  comment: string | null;
  stats: string | null;
  steps: string | null;
  changes: string | null;
};

// Not window-narrowed: asked about a row that is about to be written over, not read back.
async function storedRecord(env: Env, userId: string, id: string): Promise<StoredRecord> {
  const row = await one(
    env,
    qb
      .selectFrom('workouts')
      .select(['completed_at', 'comment', 'stats', 'steps', 'changes'])
      .where('user_id', '=', userId)
      .where('id', '=', id),
  );
  return row ?? { completed_at: null, comment: null, stats: null, steps: null, changes: null };
}

/** The history a write leaves behind: what was there, the reason it came with, the oldest dropped. */
function withChange(stored: string | null, reason: string | null | undefined): string | null {
  const changes = stored ? (JSON.parse(stored) as PlanChange[]) : [];
  if (reason) changes.push({ at: new Date().toISOString(), reason });
  return changes.length > 0 ? JSON.stringify(changes.slice(-MAX_CHANGES)) : null;
}

/** With an `id`, the row that id names is rewritten wherever it sits — the date moves with it. */
export async function putWorkout(
  env: Env,
  userId: string,
  input: WorkoutInput,
  id?: string,
  changeReason?: string | null,
): Promise<Workout> {
  let workoutId = id;

  assertRetainable(input.date);

  /**
   * A rewrite carries the completion and its stats across, but not a changed *plan* under
   * them: a lap mapped to a step that no longer exists is a confident answer about a step
   * that never ran, so once a session is recorded the steps are refused. Everything else
   * still moves; un-complete it first to change the plan.
   *
   * The steps are compared even so, for a workout un-completed while its stats stayed:
   * there the mapping is dropped and the next pass reads the recording again.
   */
  let completedAt = input.completed_at ?? null;
  let comment = input.comment ?? null;
  let stats: string | null = null;
  let changes = withChange(null, changeReason);
  const carryFrom = async (rowId: string) => {
    const stored = await storedRecord(env, userId, rowId);
    const samePlan = stored.steps === JSON.stringify(input.steps);

    if (stored.completed_at && !samePlan) {
      fail(
        'steps',
        `this workout was recorded as done on ${stored.completed_at.slice(0, 10)}, so its steps ` +
          'cannot be rewritten; mark it not done first if the session was not this one',
      );
    }
    if (input.completed_at === undefined) completedAt = stored.completed_at;
    // Carried whatever became of the plan: rewriting the steps does not make the
    // athlete's own words about the session untrue.
    if (input.comment === undefined) comment = stored.comment;
    stats = samePlan ? stored.stats : null;
    // Carried whatever became of the plan, for the same reason: why it changed stays true.
    changes = withChange(stored.changes, changeReason);
  };

  // A caller with its own key is re-syncing: land on the row that key already names.
  if (input.external_id) {
    const existing = await findByExternalId(env, userId, input.external_id);
    if (existing && workoutId === undefined) {
      workoutId = existing.id;
    } else if (existing && existing.id !== workoutId) {
      // Caught here, or the unique index breaks and the caller's mistake reads as a 500.
      fail('external_id', `"${input.external_id}" already belongs to workout ${existing.id} on ${existing.date}`);
    }
  }

  // Nothing is deleted on a move: the row keeps its key and only its date changes.
  if (workoutId !== undefined) await carryFrom(workoutId);
  // The only write that adds a row: every path reusing an id has checked it exists.
  else await assertRoomFor(env, userId, input.date);

  const workout: Workout = { id: workoutId ?? newId(), ...input, updated_at: new Date().toISOString() };
  if (completedAt) workout.completed_at = completedAt;
  else delete workout.completed_at;
  if (comment) workout.comment = comment;
  else delete workout.comment;
  if (stats) workout.stats = sessionOnly(JSON.parse(stats) as WorkoutStats);
  else delete workout.stats;
  if (changes) workout.changes = JSON.parse(changes) as PlanChange[];
  else delete workout.changes;
  await run(
    env,
    qb
      .insertInto('workouts')
      .values({
        user_id: userId,
        id: workout.id,
        date: workout.date,
        name: workout.name,
        sport: workout.sport,
        sub_sport: workout.sub_sport ?? null,
        notes: workout.notes ?? null,
        tags: workout.tags && workout.tags.length > 0 ? JSON.stringify(workout.tags) : null,
        external_id: workout.external_id ?? null,
        steps: JSON.stringify(workout.steps),
        completed_at: workout.completed_at ?? null,
        comment: workout.comment ?? null,
        stats,
        changes,
        created_at: workout.updated_at,
        updated_at: workout.updated_at,
      })
      // `created_at` is the one column left alone: it is when the row first appeared,
      // not when this write happened.
      .onConflict((clash) =>
        clash.columns(['user_id', 'id']).doUpdateSet((eb) => ({
          date: eb.ref('excluded.date'),
          name: eb.ref('excluded.name'),
          sport: eb.ref('excluded.sport'),
          sub_sport: eb.ref('excluded.sub_sport'),
          notes: eb.ref('excluded.notes'),
          tags: eb.ref('excluded.tags'),
          external_id: eb.ref('excluded.external_id'),
          steps: eb.ref('excluded.steps'),
          completed_at: eb.ref('excluded.completed_at'),
          comment: eb.ref('excluded.comment'),
          stats: eb.ref('excluded.stats'),
          changes: eb.ref('excluded.changes'),
          updated_at: eb.ref('excluded.updated_at'),
        })),
      ),
  );
  return workout;
}

/** Its own write, not a field on the plan. Null when there is no such workout. */
export async function setCompleted(
  env: Env,
  userId: string,
  id: string,
  completedAt: string | null,
): Promise<Workout | null> {
  const written = await rowsWritten(
    env,
    scopedUpdate(userId, id).set({ completed_at: completedAt, updated_at: new Date().toISOString() }),
  );
  if (written === 0) return null;
  return getWorkout(env, userId, id);
}

/**
 * One column, now that a row is keyed by its id, so nothing else has to be carried.
 * `updated_at` is bumped: the platform holding this session does have to hear about it.
 */
export async function setDate(
  env: Env,
  userId: string,
  id: string,
  date: string,
  changeReason?: string | null,
): Promise<Workout | null> {
  assertRetainable(date);

  const changes = withChange((await storedRecord(env, userId, id)).changes, changeReason);
  const written = await rowsWritten(
    env,
    scopedUpdate(userId, id).set({ date, changes, updated_at: new Date().toISOString() }),
  );
  if (written === 0) return null;
  return getWorkout(env, userId, id);
}

/**
 * Its own write, like the completion; null clears it. `updated_at` is deliberately left
 * alone — it is what the platform sync compares a plan against, and bumping it would push
 * the unchanged workout back out on the next run.
 */
export async function setComment(
  env: Env,
  userId: string,
  id: string,
  comment: string | null,
): Promise<Workout | null> {
  const written = await rowsWritten(env, scopedUpdate(userId, id).set({ comment }));
  if (written === 0) return null;
  return getWorkout(env, userId, id);
}

/** The whole document, laps and all. Read on its own, for the reason `WORKOUT_COLUMNS` gives. */
export async function getStats(env: Env, userId: string, id: string): Promise<WorkoutStats | null> {
  const window = readWindow();
  const row = await one(
    env,
    qb
      .selectFrom('workouts')
      .select('stats')
      .where('user_id', '=', userId)
      .where('id', '=', id)
      .where('date', '>=', window.from)
      .where('date', '<=', window.to),
  );
  return row?.stats ? (JSON.parse(row.stats) as WorkoutStats) : null;
}

/** Written by the platform sync alone, once the recording behind a completion has been read. */
export async function setStats(env: Env, userId: string, id: string, stats: WorkoutStats): Promise<void> {
  await run(
    env,
    qb
      .updateTable('workouts')
      .set({ stats: JSON.stringify(stats) })
      .where('user_id', '=', userId)
      .where('id', '=', id),
  );
}

export async function deleteWorkout(env: Env, userId: string, id: string): Promise<boolean> {
  const written = await rowsWritten(
    env,
    qb.deleteFrom('workouts').where('user_id', '=', userId).where('id', '=', id),
  );
  return written > 0;
}

export async function countInWindow(env: Env, userId: string, now: Date = new Date()): Promise<number> {
  const { from, to } = retentionWindow(now);
  const row = await one(
    env,
    qb
      .selectFrom('workouts')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('user_id', '=', userId)
      .where('date', '>=', from)
      .where('date', '<=', to),
  );
  return row?.n ?? 0;
}
