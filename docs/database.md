# The database

D1, one row per workout, keyed by `(user, date, id)`. The scalar fields are
real columns; only the steps are JSON, because only they have a shape that
changes.

## Migrations

Schema changes go through
[D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).
Files live in `migrations/`, numbered and applied in order, and Wrangler records
what it has run in a `d1_migrations` table, so applying twice is a no-op.

```bash
npm run db:new -- add_something   # scaffold the next numbered file
npm run db:local                  # apply to the local database
npm run db:remote                 # apply to the deployed one
npm run db:list                   # what is pending
```

The test suite replays every migration before each file, so a migration that
does not parse fails the build rather than the next deploy, and `0002` — the
one that carries data — is tested against a row in the old shape.

## On JSON in D1

D1 is SQLite, which has no `JSON` or `JSONB` column type; the storage classes
are TEXT, INTEGER, REAL, BLOB and NULL. What it does have is the JSON
functions, and those work fine in D1. So the steps are a TEXT column holding a
JSON array, with `CHECK (json_valid(steps))` to keep it honest, and they stay
queryable from SQL:

```sql
SELECT json_array_length(steps) FROM workouts WHERE user_id = ?;
```

Everything else about a workout — date, name, sport, notes — is a real column.

## The retention window

Only a rolling window is readable: **7 days back, 14 days ahead**, capped at 50
workouts per athlete at a time. Both limits are enforced on the way in — a
write outside the window, or a new workout past the cap, is refused rather than
accepted and thrown away a moment later.

Reads are bounded by the same window plus a day of slack on each side — 8 back,
15 ahead — because dates are the athlete's local day while the window is
computed in UTC, so at the edges the two can disagree by a day. Writes take the
strict window; a workout stored yesterday in Auckland is still legible today.

Every read goes through that bound, so no `from`/`to`, no date in a URL and no
hand-written FIT download URL reaches a workout outside it. That is the whole
of how the window is enforced, because:

## Nothing deletes a workout the athlete did not delete

A session that ages out of the window simply stops being visible and stays in
the table. There was a nightly sweep here once; it went, because storage is not
the binding constraint on the free tier — 5 GB against a few hundred bytes a
workout — and throwing away somebody's training history to reclaim none of it
was the wrong trade.

The cap counts only what is inside the window, which is what keeps it a rolling
limit rather than a wall after a year of training. Past it, a new workout is
refused rather than making room by deleting somebody's older session.

Two lookups are deliberately **not** narrowed to the read window, because both
are asked about a row that is about to be written over rather than read back:

- `findByExternalId`, because the key's unique index is not narrowed either, so
  a row outside the window still has to be found — otherwise a re-sync would
  try to insert a second row under the same key and break the index.
- `storedCompletion`, which reads the completion a row already carries so a
  rewrite can carry it across.

## Ordering rules for writes

- **Check the date before deleting.** Callers that move a workout delete the
  old row before writing the new one, so `assertRetainable` has to be asked
  first: failing in between would answer with a 400 and still have lost the
  workout.
- **Read the completion before the delete.** A move deletes the row the
  completion would otherwise have been carried across from.
- **The cap only counts new rows.** Every path that reuses an id has checked
  the row exists first, so the only write that adds to the count is the one no
  caller named an id for.

## Tables

| Table | Holds |
| --- | --- |
| `workouts` | The plan, one row per workout |
| `users` | An account per *(provider, subject)* |
| `sessions` | Session id hashes |
| `tokens` | API token hashes and their prefixes |
| `login_states` | In-flight sign-ins, single use, ten minutes |
| `platform_connections` | An encrypted platform credential and its standing error |
| `platform_links` | Where a workout lives upstream, its fingerprint, and the completion already applied |
| `drive_connections` | Where the scheduled copier puts an athlete's recorded sessions |
| `drive_copies` | One row per session copied or being copied, so it is never copied twice |

Ids are eight characters from a vowel-free alphabet, so they are short,
URL-safe, and cannot spell anything by accident.
