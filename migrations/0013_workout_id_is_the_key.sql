-- A workout id names a workout, whatever day it sits on.
--
-- The key was (user_id, date, id), which made the day part of a workout's
-- identity: every route had to be told where a workout was before it could say
-- what to do with it, moving one was a delete and an insert, and a caller
-- holding a date from before a move addressed nothing. The id is already
-- random enough to stand on its own, so it is made unique per athlete here and
-- the date goes back to being an ordinary column with an index on it.
--
-- SQLite cannot change a primary key in place, so the table is rebuilt — 0002
-- does the same and says why. Rows sharing an id across two dates cannot be
-- carried across as two; the `MAX(updated_at)` picks the one last written,
-- which is the one a caller reading by id would have been handed anyway.

CREATE TABLE workouts_rekeyed (
  user_id      TEXT NOT NULL,
  id           TEXT NOT NULL,           -- short id, unique within an athlete
  date         TEXT NOT NULL,           -- YYYY-MM-DD, the athlete's local date
  name         TEXT NOT NULL,
  sport        TEXT NOT NULL,
  sub_sport    TEXT,
  notes        TEXT,
  tags         TEXT CHECK (tags IS NULL OR json_valid(tags)),
  external_id  TEXT,
  steps        TEXT NOT NULL CHECK (json_valid(steps)),
  completed_at TEXT,
  comment      TEXT,
  stats        TEXT CHECK (stats IS NULL OR json_valid(stats)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

INSERT INTO workouts_rekeyed (
  user_id, id, date, name, sport, sub_sport, notes, tags, external_id, steps,
  completed_at, comment, stats, created_at, updated_at
)
SELECT
  user_id, id, date, name, sport, sub_sport, notes, tags, external_id, steps,
  completed_at, comment, stats, created_at, MAX(updated_at)
FROM workouts
GROUP BY user_id, id;

DROP TABLE workouts;

ALTER TABLE workouts_rekeyed RENAME TO workouts;

CREATE INDEX workouts_by_date ON workouts (user_id, date);

CREATE UNIQUE INDEX workouts_by_external_id
  ON workouts (user_id, external_id)
  WHERE external_id IS NOT NULL;
