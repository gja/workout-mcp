-- A workout id names a workout, whatever day it sits on.
--
-- The key was (user_id, date, id), which made the day part of a workout's
-- identity: moving one was a delete and an insert, and a caller holding a date
-- from before a move addressed nothing. The id is already random enough to
-- stand on its own, so the date goes back to being an ordinary column.
--
-- SQLite cannot change a primary key in place, so the table is rebuilt — 0002
-- does the same and says why. `MAX(updated_at)` collapses rows that shared an
-- id across two dates, keeping the one last written.

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
