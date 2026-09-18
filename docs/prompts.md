# Prompts

`prompts/list` names what is on offer, `prompts/get` returns the body as chat messages. A
client shows them as something the athlete picks — a slash command, a menu item — which is
the whole reason for using it. There is one, `getting-started`, in `src/prompts.ts`.

## Why the interview is a prompt and not just a tool

Three of the four context documents have no default, deliberately
([context.md](context.md)) — the right answer for one missing document and a poor one for a
new account, where every document is missing at once. A tool cannot fix that, because a tool
has to be chosen: an assistant that has decided to write a session will read the empty
documents, ask an obvious question or two and carry on. The prompt is the door the athlete
opens.

The body can be long because `prompts/list` carries only `name`, `title` and `description`,
so nothing pays for the interview until it is running. `src/getting-started.md` is some two
thousand words of prose, imported through both bundlers the way the workout library is.

## What the interview is made of

It reads before it asks: the three writable documents plus the library, and the recent
planned and recorded sessions if anything is already written. Nothing written is a setup;
something written is gap-filling; everything written is a *review*, where the job is to
find what has moved rather than re-ask what is answered. `update_context` replaces a
document in full, so anything already there is shown and confirmed before it goes.

Then six rounds, one per message: sport and goal; whether the assistant manages the weekly
schedule or only writes sessions on request; the week they actually have; the numbers, per
sport; indoors or outdoors and how they follow a target mid-session; and what constrains
the plan. A round per message rather than one question per turn (twenty turns) or a single
wall of questions (skimmed).

Round 4 does not simply ask for a max HR, because that answer is usually a guess: it asks
where their training is recorded and walks them to the figure their own history holds, with
two warnings — a platform's zone settings frequently hold 220 minus age, and a wrist optical
sensor spikes. What survives is written as an observed maximum with its date. An athlete on
the iPhone app is pointed at *Settings › Heart rate* instead, which applies the same two
warnings to a year of Health itself; see [ios.md](ios.md#heart-rate).

Two rules run through it. **Never invent a number**: anything unknown is written as
`*not set*` beside the test that would set it, because a guessed threshold looks like a
measurement and gets planned against for weeks. And **the answers decide the questions** —
someone who only swims is never asked about FTP.

## The rules it carries that the schemas cannot

The interview writes things into `scheduling-instructions` that no tool schema can express,
because they are about how *wide* a target may be:

- **Outdoor running: bands at least 0:30/km wide, up to a minute**, wider where pace is
  genuinely unreliable. Pace on the road moves 20–40 s/km inside a single interval, so a
  0:10 band reports honest running as a miss and planned-versus-actual stops being worth
  reading. Too wide costs less than too narrow.
- **Cycling: at least 25 W.**
- **Indoors is the exception** — a treadmill or trainer holds the number, so those bands
  may be narrower.
- **Heart rate needs no minimum**: it moves slowly and its bands are already effort-shaped.
- `workout-zones` is physiology and the single source of truth; a band written into a
  workout is a *tolerance*, allowed to be wider than the zone it came from.

## Four doors to the same interview

| Door | Who opens it | When |
| --- | --- | --- |
| the `getting-started` prompt | the athlete, from the picker | "set up my training context" |
| `get_onboarding_instructions` | the model | asked to, or a context read came back empty |
| the `workouts-mcp-onboarding-wizard` skill | either of them | a host that implements the extension |
| `next_step` on an empty read | nobody — it is just there | every read of an empty document |

A prompt reaches only the athlete and a tool only the model; the skill is the primitive the
spec lets either choose, and the other two were working around its absence. The mechanics
are in [mcp.md](mcp.md). The prompt and the tool stay for hosts that do not implement the
extension.

The tool's description says when *not* to call it: two thousand words are worth it exactly
once, so it is fetched when asked for or when a read has just come back empty — never
speculatively, and never to find out whether the athlete is set up, which the context
readers answer for nothing.

**Why not `initialize`.** An earlier draft built `instructions` per athlete. It is pushy in
a way a tool is not, it fires once per *connection* so it cannot answer "help me set up"
mid-conversation, clients vary in whether they pass it on, and it is the legacy door. The
tool costs some fifty words of `tools/list` forever, which is the price of the other three.

**Nothing is stored about who has been asked.** `next_step` is inert: it states a fact about
an empty document and stops appearing when the document is not, so the stop condition is
already stored. A flag would record that the *server* sent something, which is not the same
as the athlete having seen it.

## Adding another

Append to `PROMPTS` in `src/prompts.ts`: a name, a title, a description saying when to
reach for it, and a markdown file if the body is prose. The message goes out with role
`user` — it is the athlete asking, not an instruction the server slipped in — and an
unknown name is an invalid-params error rather than an empty message.
