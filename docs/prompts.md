# Prompts

MCP's standard template mechanism: `prompts/list` names what is on offer,
`prompts/get` returns the body as chat messages. A client shows them as
something the athlete picks — a slash command in Claude Code, a menu item
elsewhere — which is the whole reason for using it. Tools are what the model
decides to call; a prompt is what the *person* decides to start.

There is one, `getting-started`, in `src/prompts.ts`.

## Why the onboarding interview is a prompt and not a tool

Three of the four context documents have no default, deliberately — an athlete
who has said nothing about their zones is reported as having said nothing,
rather than handed a plausible default to plan against (see
[context.md](context.md)). That is the right answer for a missing document and
a poor one for a new account, where every document is missing at once and the
athlete has no idea which questions would fill them.

A tool cannot fix that, because a tool has to be *chosen*. An assistant that
has decided to write a session will read the empty documents, ask one or two
obvious questions and carry on; it will not stop and conduct an interview, and
it should not, because the athlete did not ask for one. The prompt is the door
the athlete opens: *set up my training context*, once, at the start.

## Why the body can be long

`tools/list` is charged on every session before anything is called, which is
why tool descriptions are kept to about 50 words. Prompts are not that. The
list carries only `name`, `title` and `description` — the picker is all a
client needs to offer one — and the body is sent by `prompts/get`, after the
athlete has asked for it. Nothing pays for the interview until it is running.

So `src/getting-started.md` is fifteen hundred words of prose, and it can
afford to be. It is a markdown file for the same reason the workout library is
one, and imported the same way through both bundlers — the `Text` rule for
esbuild, `vite-markdown.ts` for rolldown.

## What the interview is made of

It reads before it asks: the three writable documents plus the library, and —
if anything is already written — the recent planned and recorded sessions too.
What comes back decides the conversation. Nothing written is a setup; something
written is a gap-filling conversation; everything written is a *review*, where
the job is to find what has moved since (a fired review trigger, a block whose
weeks have run out, a constraint the actual sessions no longer match) rather
than to re-ask what is already answered. `update_context` replaces a document
in full, so anything already there is shown and confirmed before it goes.

Then six rounds, one per message: sport and goal; whether the assistant should
manage the weekly schedule or only write sessions on request; the week they
actually have; the numbers, per sport; indoors or outdoors and how they follow
a target mid-session; and what constrains the plan. A round per message rather
than one question per turn, or a single wall of questions — the first is
twenty turns, the second gets skimmed.

Two rules run through it. **Never invent a number**: anything unknown is
written as `*not set*` beside the test that would set it, because a guessed
threshold looks like a measurement and gets planned against for weeks. And
**the answers decide the questions**: someone who only swims is never asked
about FTP, and someone who wants individual workouts only gets a short
`current-plan` saying so rather than six invented weeks.

## The rules it carries that the schemas cannot

The interview writes some things into `scheduling-instructions` that the
athlete would never think to ask for and no tool schema can express, because
they are about how wide a target may be rather than what a target is:

- **Outdoor running: bands at least 0:30/km wide**, up to about 0:45. Pace on
  the road moves 20–40 s/km inside a single interval from terrain, junctions
  and ordinary variation. A 0:10 band reports honest running as a miss, and
  planned-versus-actual stops being worth reading.
- **Cycling: at least 25 W**, indoors or out.
- **Indoors is the exception**, not the rule — a treadmill or a trainer holds
  the number, so those bands may be narrower.
- **Heart rate needs no minimum**: it moves slowly and its bands are already
  effort-shaped.
- And the distinction underneath all of it: `workout-zones` is physiology and
  stays the single source of truth; a band written into a workout is a
  *tolerance*, allowed to be wider than the zone it came from.

## Reaching the model, not only the picker

A prompt is offered to the *athlete* — a slash command in Claude Code, a menu
item in Desktop. The model never sees it: it receives `tools/list` and nothing
else, and there is no way for it to call `prompts/get` on its own. That is the
right shape for "I want to redo my setup", and useless for the case this is
actually for, because a brand-new athlete does not browse a prompt picker.

So `initialize` carries the same body. Its `instructions` field is
natural-language guidance for the model, which clients prepend to the system
prompt, and it is built per athlete from what they have written:

| Written | `instructions` | Cost |
| --- | --- | --- |
| none of the three | the whole interview, under a covering note | ~2k tokens |
| some of them | one line naming what is missing | negligible |
| all three | the field is absent | none |

The expensive case is the one that pays for itself, and it is **self-limiting**:
the condition that triggers it is destroyed by the interview succeeding. That is
why there is no `start_setup` tool. A tool would be model-invocable in every
client, but it would spend ~50 words of `tools/list` on every session forever,
including the overwhelming majority where the athlete was set up months ago.

It costs one D1 read per *connection* — `initialize` is not per request — so the
instructions describe the athlete as they were when the client connected. Stale
in the harmless direction: an assistant told there is nothing written goes and
reads, and the read is current.

### Nothing is stored to say "we asked"

There is no `offered_at` column, deliberately. A flag would record that the
server sent something, which is not the same as the athlete having seen it or
turned it down — a client that connects and is closed again would burn the only
offer and leave that athlete permanently un-onboarded, which is the exact
failure this feature exists to prevent.

"Once" is therefore scoped to the conversation and carried by the wording of the
covering note, which the model can honour because its own history tells it
whether it has already asked. The durable stop condition is the thing actually
worth tracking, and it is already stored: **the documents being written**. An
athlete who would rather type them on the dashboard stops being offered the
interview by typing them, which is what they wanted to do anyway.

### And a line in the read itself

`instructions` is optional in the spec and not every client passes it on, so a
document with nothing in it also says so where it cannot be missed: every
context read carries `next_step`, which is null once something is written and
otherwise names both ways to fix it. No client feature required, no cost in the
tool list, and it arrives at the moment the emptiness is about to matter.

### `initialize` is the legacy home for this

Revision `2026-07-28` removed the handshake: version, identity and capabilities
became per-request `_meta`, and the spec now calls an `initialize` server
**legacy** (`2025-11-25` and earlier). This server pins `2025-06-18` and is
legacy by that definition, as is every client it currently talks to.

The field itself survives. A modern server **MUST** implement `server/discover`,
whose `DiscoverResult` carries the same optional `instructions`, so going
dual-era moves `instructionsFor` to a second call site rather than rewriting it.
One thing to get right when that happens: `server/discover` is cacheable, and
this `instructions` is per athlete and changes the moment they finish the
interview — so it must go out as `cacheScope: "private"` with a short `ttlMs`,
never `public`.

## Adding another

Append to `PROMPTS` in `src/prompts.ts`. A name, a title, a description that
says when to reach for it, and a markdown file if the body is prose. The
message goes out with role `user` — it is the athlete asking, not an
instruction the server slipped into the conversation — and a name that is not
in the list is an invalid-params error rather than an empty message.
