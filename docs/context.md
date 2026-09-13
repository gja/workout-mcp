# The athlete's context

Four markdown documents per athlete, and the answer to "why did it write me
*that* session":

| Kind | Holds | Built-in |
| --- | --- | --- |
| `workout-library` | The session types they train with, and how each is built | yes |
| `current-plan` | The block they are in: goal race, phase, the shape of a week | no |
| `scheduling-instructions` | Which days are training days, what must not go back to back | no |
| `workout-zones` | The watt, pace and heart-rate bands every target is anchored to | no |

They are **context, not configuration**. Nothing in them is parsed, validated
or turned into a tool argument — the schemas in `src/tools.ts` are still the
whole contract for what a workout may say. The documents only change what an
assistant *chooses* to write, which is why they can be prose and why a typo in
one is harmless.

The set of kinds is a code decision, in `src/context.ts`, not a schema one. The
`contexts` table does not constrain `kind`, because a migration per kind added
would be a migration that exists only to repeat one.

## No defaults, except the library

Only `workout-library` has a built-in document — `src/workout-library.md`,
which ships in the build. The other three have none, and that is the point: an
athlete who has said nothing about their zones gets `markdown: null` and an
assistant is *told* they have said nothing, rather than handed a plausible
default it would then plan against. A guessed threshold is worse than a missing
one.

An athlete has **no row** in `contexts` for a kind they have not written. For
the library that means a change to the default reaches everybody who has not
overridden it, instead of freezing each athlete on whatever it said the day they
signed up. For the other three it means absence is recorded as absence. Saving
writes the row; clearing deletes it and the built-in document takes over again,
where there is one. Saving an empty document means the same thing as clearing.

### Importing markdown twice over

The default library is prose, so it stays a `.md` file rather than being escaped
into a template literal — but nothing loads it for free, because the Worker is
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

## Four tools to read, one to write

Each document has its own read tool — `get_workout_library`, `get_current_plan`,
`get_scheduling_instructions`, `get_workout_zones` — rather than one tool taking
a `kind`. The tool list is what a client reads *before* it decides to call
anything, and a document reachable only through an argument is one it has to
already know to look for. Four named tools put "this athlete has zones" in front
of it without being asked. They are generated from one list (`readToolName` in
`src/context.ts`), and a test fails if a kind is added without one.

`update_context` writes, is a single tool taking the `kind`, and is deliberately
**separate** from the readers. An MCP client asks about tools one at a time, so
an athlete can allow reading their context freely and still be asked every time
something wants to rewrite it. Folding the write into a reader would have made
"look at my zones" and "replace my zones" the same permission. One writer rather
than three keeps that approval a single decision instead of three.

`workout-library` is not writable over MCP at all; `update_context` refuses it
and says where it is edited. The library is the athlete's standing brief — an
assistant that could rewrite it would be editing its own instructions, and a bad
session would quietly become a bad *standing* instruction. The other three move
with the training, so an assistant that has just agreed a plan change with the
athlete should be able to write it down. The tool description says to show the
athlete the document first, and there is no partial edit: what you send replaces
what is there.

`create_workout` and `update_workout` name all four readers, because the failure
this is all meant to prevent is a session written without reading any of them.

### The kinds are discoverable before anything is called

A client reads the tool list to decide what to call, so a name alone is not
enough: `"which document to replace"` is no help to something deciding what
belongs in a document it has not read. Every read tool's description therefore
opens with that document's `purpose`, and `update_context`'s `kind` property
carries the purpose of each kind it accepts — all generated from `CONTEXTS`
rather than written out again, so the enum, the tool prose and the dashboard
cannot drift apart. `update_context` also names the library it *excludes*, so a
client learns the library exists and is read-only rather than merely not finding
it.

## 100 KB each, in bytes

Refused on the way in rather than truncated, and measured in UTF-8 bytes rather
than characters — the limit is on what is stored and sent, not on how it is
spelled, and a document of em-dashes and accents would otherwise be three times
the size it claimed. It is prose an assistant reads in full on every session it
plans, so the binding constraint is the reader's context window rather than D1.
Silently keeping the first half of a document would be worse than saying no.

The message names both numbers in bytes. Rounding the limit to KB and the size
with it would tell the athlete whose document is one byte over that it "may be
at most 100 KB, and that one is 100 KB". A `Content-Length` far above the limit
is refused with a 413 before the body is parsed at all, so an absurd PUT is a
clear answer rather than an isolate running out of memory mid-parse.

## The backup

`GET /api/context.zip` — *Export context* on the dashboard — is every document
with something in it, one markdown file each, plus a `manifest.json` naming
which of them the athlete wrote and when they last touched each. A kind with
nothing in it appears in the manifest with no `file`, so the archive records
"nothing here" rather than leaving it to be inferred from an absence.

The built-in library goes in too, even though it is not theirs. A backup of the
context an assistant reads should be the context it reads, not only the half
that was typed.

It reuses the streaming ZIP writer in `src/recordings/zip.ts`. Nothing about
four small documents needs streaming — but a second ZIP implementation would
need the same CRC and the same central directory, and one of the two would
eventually be the one with the bug. See [recordings.md](recordings.md) for what
that writer is really for.
