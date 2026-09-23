-- Workouts planned on the platform, copied in — the direction the sync did not
-- have. See "Reading their calendar back" in docs/integrations.md.

-- Off unless the athlete asks for it, per connection.
--
-- Importing writes workouts nobody here planned, and rewrites them when they
-- change upstream, so it is a decision rather than something connecting quietly
-- starts doing. Every row that predates this is a connection made before the
-- switch existed, which is exactly what the default says.
ALTER TABLE platform_connections ADD COLUMN import_plan INTEGER NOT NULL DEFAULT 0;

-- Which side the event behind a link came from.
--
-- 'local' is one we pushed; 'platform' is one we copied in, and it decides three
-- things. It is never pushed back, so an edit here cannot leave a second event
-- beside the athlete's own. It is never removed upstream, because their event is
-- theirs. And it outlives the workout: a link naming no workout is how a
-- workout deleted here is remembered as one not to import again, which is why
-- the nightly prune — outside the window, where the import does not reach
-- either — is the only thing that clears it.
--
-- Every existing row is one we pushed, which is the default.
ALTER TABLE platform_links ADD COLUMN source TEXT NOT NULL DEFAULT 'local'
  CHECK (source IN ('local', 'platform'));
