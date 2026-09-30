-- Notes the athlete pins to a day or a span of days: travel, illness, a race.
--
-- Their own table rather than a kind of workout: a note has no steps, no sport, nothing to
-- push to a watch or a platform, and nothing to record against it.
--
-- `end_date` is always set, to `date` for a single day, so an overlap is two plain
-- comparisons. The index leads on `date` and carries `end_date`, so a read bounded by the
-- longest span a note may have stays a range scan answered from the index; see
-- docs/database.md.
CREATE TABLE IF NOT EXISTS notes (
  user_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  date       TEXT NOT NULL,           -- YYYY-MM-DD, the first day it covers
  end_date   TEXT NOT NULL CHECK (end_date >= date),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS notes_by_date ON notes (user_id, date, end_date);
