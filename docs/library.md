# The workout library

A markdown document per athlete: the sets they train with, how those sets are
built, and how their plan is meant to progress. An assistant reads it before
writing a session, so what it writes sounds like their training rather than a
generic 8x400m.

It is **context, not configuration**. Nothing in it is parsed, validated or
turned into a tool argument — the schemas in `src/tools.ts` are still the whole
contract for what a workout may say. The library only changes what an assistant
*chooses* to write, which is why it can be prose and why a typo in it is
harmless.

## The default is not a copy

`src/library/default.ts` ships in the build. An athlete who has never edited
theirs has **no row** in `workout_libraries` — they are served the built-in
document directly.

That is deliberate. Seeding a copy per athlete on first sign-in would have been
simpler at read time and wrong everywhere else: the moment the default improves,
every athlete would still be reading the version that happened to be current the
day they signed up, with no way to tell who had actually chosen their text and
who had merely never looked at it. Absence is the cleaner way to say "no
opinion". The trade is one branch in `readLibrary`, and the rule that
`custom: false` and "this markdown" are answered together so a caller never has
to ask twice.

Saving copies the text in as it stands; resetting deletes the row, and the
default takes over again — including any improvements made since. Saving an
empty document means the same thing as resetting, because there is no useful
reading of "my library is nothing".

### Why it is a `.ts` file and not a `.md` one

It reads as markdown and would be nicer to edit as a markdown file, and it was
one for about an hour. It cannot be: `wrangler deploy` bundles the Worker with
**esbuild** and `vite build` bundles it with **rolldown**, and the two have no
import spelling in common. `./default.md?raw` is what Vite wants and esbuild
rejects for want of a loader; a bare `./default.md` is what esbuild takes, given
a `Text` rule in `wrangler.jsonc`, and Vite then tries to parse the markdown as
JavaScript. Neither tool is wrong, and the Workers build is the one that has to
work. A module exporting a template literal needs nothing from either.

## Read-only over MCP

`get_workout_library` returns the markdown and a note saying where it can be
changed: the dashboard, or `PUT /api/library`. There is no write tool, and the
asymmetry is the point. The library is how the athlete tells an assistant what
their training looks like; an assistant that could rewrite it would be editing
its own instructions, and a bad session would quietly become a bad *standing*
instruction. Edits stay on the surfaces the athlete drives themselves.

The tool result carries `custom`, so an assistant can tell "this athlete wrote
this" from "nobody has set one" and hedge accordingly.

## Size

100,000 characters, refused on the way in rather than truncated. It is prose an
assistant reads in full on every session it plans, so the binding constraint is
the reader's context window rather than D1 — a library nobody can afford to read
is not a working library, and silently keeping the first half of one would be
worse than saying no.
