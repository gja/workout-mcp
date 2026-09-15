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

## Adding another

Append to `PROMPTS` in `src/prompts.ts`. A name, a title, a description that
says when to reach for it, and a markdown file if the body is prose. The
message goes out with role `user` — it is the athlete asking, not an
instruction the server slipped into the conversation — and a name that is not
in the list is an invalid-params error rather than an empty message.
