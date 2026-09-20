# The database

D1, one row per workout, keyed by `(user, id)`. The date is an ordinary column with an
index on it, not part of the key, so moving a workout is an update of one column and the
id it was created with names it for as long as it exists. Scalar fields are real columns;
the steps, the tags and the stats are JSON.

## Queries are built, not written

Queries are compiled by [Kysely](https://kysely.dev) and run by D1. Kysely is used as a
compiler and nothing else: there is no driver and no connection, because its SQLite
compiler already emits the positional `?` placeholders and ordered parameter array that
`D1Database.prepare` and `.bind` want. `src/sql.ts` holds the setup and the only four
ways to reach the database — `all`, `one`, `changes` and `run` — each of which ends in
`env.DB.prepare`.

```ts
const rows = await all(env, scopedWorkouts(userId, readWindow()).where('id', 'in', ids));
```

The `Schema` type in `src/sql.ts` is *types only*. It is erased at build, so it cannot
drift into being a second description of the schema beside `migrations/`, which stays the
one place the tables are defined.

Queries Kysely expresses badly stay hand-written, and the same four helpers take a
`{ sql, parameters }` pair instead of a builder. Two do: `accountSharedWithOthers`, whose
correlated subquery reads better as SQL, and `pruneOrphanedLinks`, the nightly sweep that
runs across every athlete rather than inside one.

## Migrations

[D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) in
`migrations/`, numbered and applied in order; Wrangler records what it has run, so
applying twice is a no-op.

```bash
npm run db:new -- add_something   # scaffold the next numbered file
npm run db:local                  # apply to the local database
npm run db:remote                 # apply to the deployed one
npm run db:list                   # what is pending
```

## JSON in D1

SQLite has no JSON column type but does have the JSON functions, so `steps`, `tags` and
`stats` are TEXT with `CHECK (json_valid(...))` and stay queryable:

```sql
SELECT json_array_length(steps) FROM workouts WHERE user_id = ?;
```

`stats` is NULL until a session comes back; see [stats.md](stats.md). `comment` is plain
TEXT, written by its own verb rather than by the plan, so a rewrite of the steps cannot
touch it — see [workouts.md](workouts.md#saying-how-it-went).

## The retention window

Only a rolling window is readable: **7 days back, 14 ahead**, capped at 50 workouts per
athlete. Both are enforced on the way in, so a write outside them is refused rather than
accepted and thrown away.

Reads take the same window plus a day of slack each side, because dates are the
athlete's local day while the window is computed in UTC. Every read goes through that
bound, which is the whole of how the window is enforced.

**Nothing deletes a workout the athlete did not delete.** A session that ages out stops
being visible and stays in the table: storage is not the binding constraint (5 GB against
a few hundred bytes a workout). The cap counts only what is inside the window, so it is a
rolling limit rather than a wall after a year of training.

Every single-workout read and write narrows on the row's *stored* date, never on one the
caller gave, which is how the window survives the caller's date being ignored. Rather
than each query repeating that bound, `scopedWorkouts` and `scopedUpdate` in `src/db.ts`
start from it and callers narrow further. Kysely builders are immutable, so an added
`.where(...)` is an `and` on a fresh builder: a caller can ask for less than the window
but has no way to ask for more.

Two lookups are deliberately **not** narrowed, because both read a row that is about to
be written over: `findByExternalId`, since its unique index is not narrowed either and a
re-sync would otherwise insert a duplicate under the same key; and `storedRecord`, which
a rewrite carries across.

## Ordering rules for writes

- **Check the date before writing it.** `assertRetainable` is asked first, so a day
  nothing could be read back from is a 400 rather than a row nobody can see.
- **Read what a rewrite carries before overwriting it.** The completion, the note and the
  stats are read off the stored row, and the stats are kept only where the steps are
  unchanged — see `putWorkout`.
- **The cap only counts new rows.** Every path that reuses an id has checked the row
  exists, so the only write that adds to the count is the one with no id named.

## Tables

| Table | Holds |
| --- | --- |
| `workouts` | The plan, plus the stats of the session recorded against it and the athlete's note |
| `users` | A sign-in per *(provider, subject)*, and the account it is, or is linked to |
| `contexts` | An athlete's context documents, one row per kind they have written |
| `sessions` | Session id hashes |
| `tokens` | API token hashes and their prefixes |
| `login_states` | In-flight sign-ins, single use, ten minutes |
| `platform_connections` | An encrypted platform credential and its standing error |
| `platform_links` | Where a workout lives upstream, its fingerprint, the completion applied |
| `drive_connections` | Where the copier puts an athlete's recorded sessions |
| `drive_copies` | One row per session copied, so it is never copied twice |

A row in `contexts` exists only for a kind the athlete has written, so the built-in
library reaches everyone who has not overridden it and absence is recorded as absence.
`kind` is unconstrained in SQL — the set lives in `src/context.ts`. See
[context.md](context.md).

Ids are eight characters from a vowel-free alphabet: short, URL-safe, and unable to spell
anything by accident.
