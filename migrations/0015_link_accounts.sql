-- One person, one account, however they sign in.
--
-- An account is keyed by (provider, subject), so signing in with Apple after
-- Google made a second account with nothing in it. A row now says whether it is
-- an account or a way into one: `alias_of_user_id` is null for an account, and
-- names the account for a sign-in linked to it.
--
-- The link is made on a verified address, which is why the flag is stored: a
-- provider that will not vouch for an address cannot attach anything with it.
-- What that does and does not join is in docs/auth.md.
--
-- Nothing is linked retroactively. A row keeps the account it has, and a second
-- account already made stays one until it is deleted; the next sign-in with that
-- provider is a new row, which is what finds the first.

ALTER TABLE users ADD COLUMN alias_of_user_id TEXT;
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

-- Taking what is already here as vouched for. This is an assumption, not a fact:
-- the code that wrote these rows stored the address without recording whether the
-- provider had verified it, and Google can say it has not. The alternative is
-- worse for the athletes this is for — an account already here would match
-- nothing until its own provider signed in again, so the second account this
-- migration exists to prevent is exactly what they would get. An intervals.icu
-- row has no address at all, and a null is not a match for anything.
UPDATE users SET email_verified = 1 WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS users_by_email ON users (email);
