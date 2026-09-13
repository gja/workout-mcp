-- Free-form labels on a workout: `key`, `quality`, `long run`.
--
-- A JSON array of strings, for the same reason the steps are one — a list has
-- no shape a column can hold — with `json_valid` to keep it honest and NULL
-- meaning "no tags", which is what every existing row is.
--
-- What they are for is the calendar at the other end: intervals.icu carries a
-- `tags` array on a calendar event and filters on it, so a session tagged
-- `key` here is one the athlete can pick out there. Nothing here reads them.

ALTER TABLE workouts ADD COLUMN tags TEXT
  CHECK (tags IS NULL OR json_valid(tags));
