-- Store the steps on their own instead of the whole workout as one blob.
--
-- The old `data` column repeated date, name and sport, which are already
-- columns, so the row had two sources of truth. Only the steps genuinely need
-- to be JSON, and SQLite has no JSON column type — a TEXT column holding valid
-- JSON is the idiomatic form, and `json_valid` keeps it honest.
--
-- SQLite cannot add a NOT NULL column to a populated table, so this rebuilds
-- the table, which also lets the new constraints be exact.

CREATE TABLE workouts_rebuilt (
  user_id    TEXT NOT NULL,
  date       TEXT NOT NULL,           -- YYYY-MM-DD, the athlete's local date
  id         TEXT NOT NULL,           -- short id, unique within a user+date
  name       TEXT NOT NULL,
  sport      TEXT NOT NULL,
  notes      TEXT,
  steps      TEXT NOT NULL CHECK (json_valid(steps)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, date, id)
);

INSERT INTO workouts_rebuilt (user_id, date, id, name, sport, notes, steps, created_at, updated_at)
SELECT
  user_id,
  date,
  id,
  name,
  sport,
  json_extract(data, '$.notes'),
  json_extract(data, '$.steps'),
  created_at,
  updated_at
FROM workouts
WHERE json_valid(data) AND json_extract(data, '$.steps') IS NOT NULL;

DROP TABLE workouts;

ALTER TABLE workouts_rebuilt RENAME TO workouts;

CREATE INDEX workouts_by_date ON workouts (user_id, date);
