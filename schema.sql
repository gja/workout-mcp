-- Run with: npx wrangler d1 execute workout-mcp --remote --file=./schema.sql

-- An athlete. Identity is the email address; there is no password.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,   -- always stored lower-cased
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

-- One-time login codes, at most one outstanding per email address.
CREATE TABLE IF NOT EXISTS login_codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Browser sessions for the dashboard, held in an httpOnly cookie.
CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Hand-made API tokens, for a watch app or an MCP client that only takes a
-- static header. OAuth clients, grants and their tokens are not here: the
-- OAuth provider keeps those in the OAUTH_KV namespace.
CREATE TABLE IF NOT EXISTS tokens (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT,                   -- what the athlete called it
  prefix       TEXT NOT NULL,          -- first few characters, to show in the UI
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS tokens_by_user ON tokens (user_id);

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
