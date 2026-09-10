-- Run with: npx wrangler d1 execute workout-mcp --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workouts (
  user_id    TEXT NOT NULL,
  date       TEXT NOT NULL,           -- YYYY-MM-DD, the athlete's local date
  id         TEXT NOT NULL,           -- short id, unique within a user+date
  name       TEXT NOT NULL,
  sport      TEXT NOT NULL,
  data       TEXT NOT NULL,           -- the normalized workout, as JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, date, id)
);

CREATE INDEX IF NOT EXISTS workouts_by_date ON workouts (user_id, date);
