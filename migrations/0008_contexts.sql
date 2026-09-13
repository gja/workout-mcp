-- The athlete's context: the markdown documents an assistant reads before it
-- plans anything. One row per athlete per kind, and only for a kind they have
-- actually written.
--
-- The built-in workout library ships in the source (`src/workout-library.md`),
-- so an athlete who has never edited it has no row here rather than a copy of
-- the same text — which is what keeps a change to it reaching everybody who has
-- not overridden it. The other kinds have no built-in document at all: no row
-- means nothing has been said, and an assistant is told so rather than handed a
-- guess.
--
-- `kind` is not constrained here. The set of kinds is a code decision, in
-- src/context.ts, and a migration per kind added would be a migration that
-- exists only to repeat one.

CREATE TABLE IF NOT EXISTS contexts (
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  markdown   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind)
);
