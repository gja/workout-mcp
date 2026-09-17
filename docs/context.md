# The athlete's context

Four markdown documents per athlete, and the answer to "why did it write me *that*
session":

| Kind | Holds | Built-in |
| --- | --- | --- |
| `workout-library` | The session types they train with, and how each is built | yes |
| `current-plan` | The block they are in: goal race, phase, the shape of a week | no |
| `scheduling-instructions` | Which days are training days, what must not go back to back | no |
| `workout-zones` | The watt, pace and heart-rate bands every target is anchored to | no |

They are **context, not configuration**: nothing in them is parsed or turned into a tool
argument, so they can be prose and a typo in one is harmless. The schemas in
`src/tools.ts` are still the whole contract. The set of kinds lives in `src/context.ts`,
not in the schema — `contexts.kind` is unconstrained, because a migration per kind added
would exist only to repeat one.

## No defaults, except the library

Only `workout-library` has a built-in document (`src/workout-library.md`, compiled into
the build). The other three have none deliberately: an athlete who has said nothing about
their zones gets `markdown: null` and an assistant is *told* so, rather than handed a
plausible default. A guessed threshold is worse than a missing one.

An empty document carries `next_step` naming `get_onboarding_instructions`, and is
**absent** on a document with something in it — the absence is the signal, so it carries
the remedy. It names the tool alone, because a model never sees a prompt. Absent rather
than `null` (unlike the figures in [stats.md](stats.md), where an explicit null is
load-bearing) because `markdown` has already said the document is empty.

An athlete has **no row** for a kind they have not written. For the library that means
improving the default reaches everyone who has not overridden it; for the rest it means
absence is recorded as absence. Clearing deletes the row, and saving an empty document
means the same thing.

### Importing markdown twice over

The default library stays a `.md` file rather than being escaped into a template literal,
but the Worker is bundled by two different tools:

| Build | Bundler | How the import resolves |
| --- | --- | --- |
| `wrangler deploy` (what Workers Builds runs) | esbuild | the `Text` rule in `wrangler.jsonc` |
| `vite build`, `vite dev`, the test suite | rolldown | `vite-markdown.ts` |

Both take the same bare `import … from './workout-library.md'`, which is the point:
`?raw` is Vite's spelling and esbuild rejects it, while a `Text` rule alone leaves
rolldown parsing markdown as JavaScript. The first version of this deployed red for
exactly that reason with every test green.

## Four tools to read, one to write

Each document has its own read tool — `get_workout_library`, `get_current_plan`,
`get_scheduling_instructions`, `get_workout_zones` — rather than one tool taking a
`kind`, because the tool list is what a client reads *before* it decides to call
anything: a document reachable only through an argument is one it has to already know to
look for. They and their descriptions are generated from `CONTEXTS`, so the enum, the
prose and the dashboard cannot drift; a test fails if a kind is added without a reader.

`update_context` writes, takes the `kind`, and is deliberately **separate**: an MCP client
approves tools one at a time, so an athlete can allow reading their context freely and
still be asked before something rewrites it. There is no partial edit — what you send
replaces what is there.

`workout-library` is not writable over MCP. It is the athlete's standing brief, and an
assistant that could rewrite it would be editing its own instructions; the other three
move with the training. `create_workout` and `update_workout` name all four readers,
because a session written without reading any of them is the failure this exists to
prevent.

## 100 KB each, in bytes

Refused on the way in rather than truncated, and measured in UTF-8 bytes rather than
characters — the limit is on what is stored and sent. The binding constraint is the
reader's context window, and silently keeping the first half of a document would be worse
than saying no. The message names both numbers in bytes, so an athlete one byte over is
not told their 100 KB document may be at most 100 KB. A `Content-Length` far above the
limit is refused with a 413 before the body is parsed.

## The backup

`GET /api/context.zip` — *Export context* on the dashboard — is every document with
something in it, one markdown file each, plus a `manifest.json` naming which the athlete
wrote and when. An empty kind appears in the manifest with no `file`, so the archive
records "nothing here". The built-in library goes in too: a backup of the context an
assistant reads should be the context it reads.

It reuses the streaming ZIP writer in `src/recordings/zip.ts` — nothing here needs
streaming, but a second implementation would need the same CRC and central directory, and
one of the two would eventually be the one with the bug.
