-- Why the plan changed, in the words of whoever changed it.
--
-- A JSON array on the workout, not a table of its own: it is read whenever the
-- workout is read and never on its own, it is bounded (the newest ten entries,
-- on a row that lives three weeks), and a join for it would be a second read
-- on every list. Same reasoning as `tags` and `stats`, and `json_valid` keeps
-- it honest.
--
-- Entries are {at, reason} and are appended by an update or a move, never
-- edited: the note is what was true when the change was made. NULL means
-- nothing has been explained, which is what every existing row is.
ALTER TABLE workouts ADD COLUMN changes TEXT
  CHECK (changes IS NULL OR json_valid(changes));
