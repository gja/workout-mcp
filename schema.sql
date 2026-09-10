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

-- Every bearer credential: hand-made API tokens, and the access and refresh
-- tokens issued by the OAuth flow. One table means one lookup path in auth.
CREATE TABLE IF NOT EXISTS tokens (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,          -- 'api' | 'access' | 'refresh'
  name         TEXT,                   -- what the athlete called it
  prefix       TEXT NOT NULL,          -- first few characters, to show in the UI
  client_id    TEXT,                   -- set for OAuth tokens
  expires_at   TEXT,                   -- NULL never expires
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS tokens_by_user ON tokens (user_id, kind);

-- MCP clients that registered themselves (RFC 7591). Public clients: no secret.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,         -- JSON array of exact-match URIs
  created_at    TEXT NOT NULL
);

-- Authorization codes: single use, short lived, PKCE required.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource       TEXT,
  expires_at     TEXT NOT NULL
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
