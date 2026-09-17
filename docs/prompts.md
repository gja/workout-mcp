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

So `src/getting-started.md` is some two thousand words of prose, and it can
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

Round 4 does not simply ask for a max HR, because the answer to that question is
usually a guess. It asks where their training is recorded — Apple Watch, Garmin,
Strava, Coros, whatever — and walks them to the figure their own history already
holds, naming the app for a watch when they are not sure which they use. Two
warnings come with it: the max HR sitting in a platform's zone settings is
frequently 220 minus age rather than anything measured, and a wrist optical
sensor spikes, so a peak that appears in one session and nowhere near it again
is an artefact. What survives is written as an observed maximum with its date,
and noted as a floor rather than a true max.

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

- **Outdoor running: bands at least 0:30/km wide, up to a minute**, and wider
  where something makes pace genuinely unreliable — trails, hills, heat, a route
  full of junctions. Pace on the road moves 20–40 s/km inside a single interval
  from terrain, junctions and ordinary variation. A 0:10 band reports honest
  running as a miss, and planned-versus-actual stops being worth reading. Too
  wide costs less than too narrow: the first is vague, the second is wrong.
- **Cycling: at least 25 W**, indoors or out.
- **Indoors is the exception**, not the rule — a treadmill or a trainer holds
  the number, so those bands may be narrower.
- **Heart rate needs no minimum**: it moves slowly and its bands are already
  effort-shaped.
- And the distinction underneath all of it: `workout-zones` is physiology and
  stays the single source of truth; a band written into a workout is a
  *tolerance*, allowed to be wider than the zone it came from.

## Three doors to the same interview

The body in `src/getting-started.md` is reached three ways, because the one that
is right for a person is no use to a model and vice versa:

| Door | Who opens it | When |
| --- | --- | --- |
| the `getting-started` prompt | the athlete, from the picker | "set up my training context" |
| `get_onboarding_instructions` | the model | asked to, or a context read came back empty |
| the `workouts-mcp-onboarding-wizard` skill | either of them | a host that implements the extension |
| `next_step` on an empty read | nobody — it is just there | every read of a document with nothing in it |

The skill is the one the other two were working around: a prompt reaches only
the athlete, a tool only the model, and a skill is the primitive the spec lets
either choose. It is served over MCP as well, and the mechanics — the manifest,
the digests, why its name is qualified where the prompt's is not — are in
[mcp.md](mcp.md). The prompt and the tool stay, because a host that does not
implement the extension still has to be able to reach the thing.

A prompt is offered to the athlete alone: the model receives `tools/list` and
nothing else, and cannot call `prompts/get` on its own. That is the right shape
for "I want to redo my setup" and no use for the case the interview is actually
for, because a brand-new athlete does not browse a prompt picker. So the same
body sits behind a tool, which works in every client whether or not it
implements prompts, and can be reached mid-conversation rather than only at the
moment a client connects.

The tool's description says when *not* to call it. It returns some two thousand
words, which is worth it exactly once and wasteful on every session after, so it
is fetched when asked for or when a read has just come back empty —
never speculatively, and never as a way of finding out whether the athlete is
set up, which the context readers answer for nothing.

### Why not `initialize`

`initialize` has an `instructions` field, and an earlier draft built it per
athlete: the whole interview while the documents were empty, nothing once they
were filled. It reads well and it was dropped.

It is pushy in a way a tool is not — every session with an empty context opens
with the model already holding an interview it will try to start. It fires once
per *connection*, so it cannot answer "help me set up" said in the middle of a
conversation. `instructions` is optional and clients vary in whether they pass
it on. And it is the legacy door: see [mcp.md](mcp.md).

The tool costs what `initialize` did not — some fifty words of `tools/list` on
every session forever — and that is the price of the other three properties.

### Nothing is stored about who has been asked

There is no `offered_at` column, and with nothing being pushed there is nothing
to remember. `next_step` is inert: it states a fact about a document that is
empty, and stops appearing when the document is not, so the stop condition is
the thing actually worth tracking and it is already stored. An athlete who would
rather type their zones on the dashboard silences it by typing them.

A flag would have been worse than useless. It would record that the *server*
sent something, which is not the same as the athlete having seen it or turned it
down — a client that connects once and is closed would burn the only offer and
leave that athlete permanently un-onboarded, which is the failure this exists to
prevent.

## Adding another

Append to `PROMPTS` in `src/prompts.ts`. A name, a title, a description that
says when to reach for it, and a markdown file if the body is prose. The
message goes out with role `user` — it is the athlete asking, not an
instruction the server slipped into the conversation — and a name that is not
in the list is an invalid-params error rather than an empty message.
