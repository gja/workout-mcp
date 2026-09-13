-- What the athlete actually did, read off the recorded FIT file once.
--
-- A JSON document rather than columns, for the same reason `steps` is one: it
-- is a session summary plus a list of laps, each with four quarters and the
-- target it was run against, and that has no shape a table holds. `json_valid`
-- keeps it honest and NULL means "no recording has come back yet", which is
-- what every existing row is.
--
-- It is written by the platform sync, never by a caller: the recording is the
-- platform's, and the only thing that reads it is `src/stats.ts`. Second-by-
-- second streams are deliberately not kept — see docs/stats.md.

ALTER TABLE workouts ADD COLUMN stats TEXT
  CHECK (stats IS NULL OR json_valid(stats));
