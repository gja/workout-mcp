-- When the session was actually done.
--
-- Null means it is still only planned, which is what every existing row is.
-- The value is an instant rather than a day: `date` is already the day it was
-- planned for, and a run logged at 06:30 on a day it was not planned for is
-- worth being able to tell apart from one that landed as scheduled.
ALTER TABLE workouts ADD COLUMN completed_at TEXT;
