-- Syncing planned workouts to the athlete's Garmin Connect calendar.
--
-- Three tables, for the three things the integration has to remember: the
-- athlete's Garmin credentials, a connect flow that is still in the air, and
-- which Garmin workout each of ours became.

-- One Garmin account per athlete.
--
-- The tokens are the one secret in this schema that has to be recoverable
-- rather than merely checkable, so unlike sessions and API tokens they are
-- encrypted rather than hashed — see src/garmin/crypto.ts. `key_id` names the
-- key they were sealed with, so a rotated secret is reported as "reconnect
-- your Garmin account" instead of failing to decrypt somewhere deeper.
CREATE TABLE IF NOT EXISTS garmin_connections (
  user_id            TEXT PRIMARY KEY,
  garmin_user_id     TEXT,                    -- Garmin's own id for the athlete
  access_token       TEXT NOT NULL,           -- sealed
  refresh_token      TEXT NOT NULL,           -- sealed
  key_id             TEXT NOT NULL,
  access_expires_at  TEXT NOT NULL,
  refresh_expires_at TEXT,
  connected_at       TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  -- What happened last time we pushed, so the dashboard and the MCP tools can
  -- say so without having to sync again to find out.
  last_sync_at       TEXT,
  last_sync_error    TEXT,
  -- Whether the nightly sweep pushes for this athlete, or only they do.
  auto_sync          INTEGER NOT NULL DEFAULT 1
);

-- In-flight connect flows: the CSRF state and the PKCE verifier, held
-- server-side and single use, exactly as sign-in does it in `login_states`.
-- Unlike sign-in this one also names the athlete, because connecting Garmin
-- happens while already signed in and the callback has to land on the right
-- account.
CREATE TABLE IF NOT EXISTS garmin_connect_states (
  state         TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to     TEXT,                         -- same-origin path to land on
  expires_at    TEXT NOT NULL
);

-- The link between one of our workouts and what it became on Garmin.
--
-- Keyed by our workout id alone rather than by (date, id) as `workouts` is:
-- the id survives a workout being moved to another day, and that is precisely
-- the case that has to update the existing Garmin workout and re-schedule it
-- rather than leave a duplicate behind on the old date.
--
-- `fingerprint` is a hash of the payload we last pushed, so a sync that
-- changes nothing costs no Garmin calls.
CREATE TABLE IF NOT EXISTS garmin_workouts (
  user_id            TEXT NOT NULL,
  workout_id         TEXT NOT NULL,
  garmin_workout_id  TEXT NOT NULL,
  garmin_schedule_id TEXT,
  scheduled_date     TEXT NOT NULL,
  fingerprint        TEXT NOT NULL,
  synced_at          TEXT NOT NULL,
  PRIMARY KEY (user_id, workout_id)
);

CREATE INDEX IF NOT EXISTS garmin_workouts_by_date ON garmin_workouts (user_id, scheduled_date);
