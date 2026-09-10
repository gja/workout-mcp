-- Two optional fields on a workout.
--
-- `sub_sport` is how the sport is done — treadmill, track, indoor cycling —
-- which a watch uses to pick the activity profile.
--
-- `external_id` is the caller's own key for a workout, so a planner that
-- re-syncs its plan updates the same row instead of piling up duplicates and
-- quietly pushing older sessions past the per-user cap. It is unique per
-- athlete, and only when set, which is what the partial index expresses.

ALTER TABLE workouts ADD COLUMN sub_sport TEXT;

ALTER TABLE workouts ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX workouts_by_external_id
  ON workouts (user_id, external_id)
  WHERE external_id IS NOT NULL;
