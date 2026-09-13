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

`src/workout-library.md` ships in the build, imported as a string. An athlete
who has never edited theirs has **no row** in `workout_libraries` — they are
served the built-in document directly.

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

### Importing markdown twice over

The document is prose, so it stays a `.md` file rather than being escaped into
a template literal — but nothing loads it for free, because the Worker is
bundled by two different tools:

| Build | Bundler | How the import resolves |
| --- | --- | --- |
| `wrangler deploy`, which is what Workers Builds runs | esbuild | the `Text` rule in `wrangler.jsonc` |
| `vite build`, `vite dev` and the test suite | rolldown | `vite-markdown.ts` |

Both take the same bare `import … from './workout-library.md'`, which is the
point: the two halves have to agree on the spelling or one of them breaks. They
nearly did not. `?raw` is Vite's spelling and esbuild rejects it for want of a
loader — the first version of this feature deployed red for exactly that reason,
with `vite build` and every test green. A `Text` rule alone is esbuild's
spelling and rolldown then tries to parse the markdown as JavaScript. One plugin
plus one rule is what it costs to keep the file a file.

`vite-markdown.ts` is a `transform` hook rather than a `load` one, so it needs
no filesystem access and stays out of the Node-typed half of the build; it is
`enforce: 'pre'` because the markdown has to become JavaScript before anything
downstream tries to parse it as such.

## Read-only over MCP

`get_workout_library` returns the markdown and a note saying where it can be
changed: the dashboard, or `PUT /api/workout-library`. There is no write tool,
and the asymmetry is the point. The library is how the athlete tells an
assistant what their training looks like; an assistant that could rewrite it
would be editing its own instructions, and a bad session would quietly become a
bad *standing* instruction. Edits stay on the surfaces the athlete drives
themselves.

The tool result carries `custom`, so an assistant can tell "this athlete wrote
this" from "nobody has set one" and hedge accordingly.

## Size

100,000 characters, refused on the way in rather than truncated. It is prose an
assistant reads in full on every session it plans, so the binding constraint is
the reader's context window rather than D1 — a library nobody can afford to read
is not a working library, and silently keeping the first half of one would be
worse than saying no.
