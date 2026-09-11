-- Connections to training platforms, and what we have pushed to them.
--
-- One credential per athlete per platform. The credential is encrypted rather
-- than hashed, unlike a session or an API token: it has to be replayed to the
-- platform on every push, so it cannot be one-way. The key comes from the
-- CREDENTIALS_SECRET binding; without it a connection cannot be stored at all.
CREATE TABLE IF NOT EXISTS platform_connections (
  user_id    TEXT NOT NULL,
  platform   TEXT NOT NULL,          -- 'intervals'
  secret     TEXT NOT NULL,          -- the athlete's API key, encrypted
  account    TEXT,                   -- whose account it is, for display
  last_error TEXT,                   -- why the last sync failed, or null
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, platform)
);

-- Where one of our workouts lives on a platform.
--
-- `remote_id` is a cache rather than the source of truth: a push is an upsert
-- on a key derived from the workout, so a row lost to the retention sweep is
-- recovered by the next push instead of leaving a duplicate upstream. It is
-- needed because a delete has to name the remote event by its own id.
--
-- Keyed by date as well as workout id, because a workout id is only unique
-- within a date. Moving a workout moves its link with it.
-- `fingerprint` is a digest of the plan as it was last pushed, so a sync can
-- tell a workout that has actually changed from one whose row was merely
-- written again — recording a completion read back off the platform bumps
-- `updated_at`, and comparing timestamps would push the plan straight back
-- out over a change the platform itself told us about.
CREATE TABLE IF NOT EXISTS platform_links (
  user_id     TEXT NOT NULL,
  platform    TEXT NOT NULL,
  date        TEXT NOT NULL,
  workout_id  TEXT NOT NULL,
  remote_id   TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  synced_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, platform, date, workout_id)
);

-- Completions come back the other way, keyed by the remote event.
CREATE INDEX IF NOT EXISTS platform_links_by_remote ON platform_links (user_id, platform, remote_id);
