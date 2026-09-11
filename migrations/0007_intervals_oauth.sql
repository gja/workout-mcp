-- intervals.icu as an OAuth app: a sign-in provider, and the only way a platform
-- is connected now that the pasted API key is gone. See docs/auth.md.

-- The platform's own id for the account, kept alongside the display name in
-- `account`. A webhook names the athlete and nothing else, so this is the only
-- way back from one to the connections it concerns.
ALTER TABLE platform_connections ADD COLUMN account_id TEXT;

-- Deliberately not unique. Signing in with intervals.icu makes its own account
-- (users are keyed by provider and subject), so one athlete legitimately maps to
-- more than one user here — someone who signed in with Google and connected
-- intervals.icu, then later used the intervals.icu button. A webhook fans out to
-- every connection it matches.
CREATE INDEX IF NOT EXISTS platform_connections_by_account
  ON platform_connections (platform, account_id);

-- Every row that predates this holds a pasted API key, which is no longer a
-- credential this sends anywhere: the adapter presents a bearer token now, and a
-- key in that header is simply a 401 on every push. Cleared rather than left to
-- fail, so the dashboard offers Connect instead of reporting someone else's
-- outage. Their links go too, or the next sync would think the calendar is
-- already in step; re-authorizing pushes the plan back out from scratch.
DELETE FROM platform_links WHERE platform = 'intervals';
DELETE FROM platform_connections WHERE platform = 'intervals';

-- Which athlete a connect-intent flow belongs to. Null for a sign-in, which has
-- nobody yet. The callback insists this matches the session that arrives with
-- it, so a link followed in a browser signed in as someone else cannot attach
-- the token to the wrong account.
ALTER TABLE login_states ADD COLUMN user_id TEXT;
