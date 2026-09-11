-- Where an athlete wants their race files put, and which ones have been put there.
--
-- `drive_id` is a Google shared-drive id, not a credential: it is an identifier
-- Google hands out to anyone who can open the drive, and it is useless without
-- the service account being a member. So unlike a platform API key it is stored
-- in the clear, and the drive integration works with no CREDENTIALS_SECRET set.
--
-- No column here holds anything about the race itself. The file is streamed
-- from the platform to Google Drive and never lands in this database; see
-- docs/drive.md.
CREATE TABLE IF NOT EXISTS drive_connections (
  user_id    TEXT NOT NULL PRIMARY KEY,
  drive_id   TEXT NOT NULL,
  drive_name TEXT,                    -- what Google calls the drive, for display
  last_error TEXT,                    -- why the last copy failed, or null
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per race already copied, so the hourly pass copies each one once.
--
-- This is the whole of "has it been synced": a race is copied when it first
-- appears and never again, so an athlete who renames or re-analyses it upstream
-- does not get a second file, and one who edits the copy in Drive does not have
-- their edit overwritten. `path` is kept only so the dashboard can say where a
-- file went without asking Google.
CREATE TABLE IF NOT EXISTS drive_copies (
  user_id   TEXT NOT NULL,
  platform  TEXT NOT NULL,            -- 'intervals'
  remote_id TEXT NOT NULL,            -- the platform's id for the recorded race
  path      TEXT NOT NULL,            -- where it landed inside the drive
  file_id   TEXT,                     -- Google's id for the uploaded file
  copied_at TEXT NOT NULL,
  PRIMARY KEY (user_id, platform, remote_id)
);

-- The dashboard lists an athlete's most recent copies.
CREATE INDEX IF NOT EXISTS drive_copies_by_time ON drive_copies (user_id, copied_at);
