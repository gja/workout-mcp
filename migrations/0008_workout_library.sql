-- The athlete's own workout library: the reference the assistant reads before
-- writing a session.
--
-- One row per athlete, and only once they have edited it. The built-in library
-- ships in the source (`src/library.md`), so an athlete who has never touched
-- it has no row here rather than a copy of the same text — which is what keeps
-- a change to the default reaching everybody who has not overridden it.

CREATE TABLE IF NOT EXISTS workout_libraries (
  user_id    TEXT PRIMARY KEY,
  markdown   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
