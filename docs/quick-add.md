# Quick add

A date and a sentence — "easy 25 min, then strides 20 s on, 2 min off" — turned into a
workout by a small model on Workers AI. It is for a phone and a minute, not for planning:
Claude with the MCP tools is that.

## It only drafts

`POST /api/quick-add` takes `{date, description}` and answers `{workout}`: the JSON
`POST /api/workouts` takes. Nothing is saved. The dashboard shows the draft, lets the
athlete edit it, and saves it with the ordinary create, so every write still goes through
`src/plan.ts`.

The draft is run through `parseWorkout` before it is returned, the same parser a create
uses, so a draft that comes back will save. One that does not validate is a `422` carrying
the field-naming `error` and the model's raw `reply`. The date is always the one asked for;
the model's own is overwritten.

## What the model sees

The format, one example, the athlete's **workout zones** (the first 4000 characters) and
the description. Nothing else: not the plan, not past sessions, not the other context
documents. That keeps every call small, and it is why the dialog says quick add cannot see
their training.

## The model

`@cf/meta/llama-3.1-8b-instruct-fp8-fast`, named once as `DRAFT_MODEL` in
`src/quick-add.ts`. The 1B Llama is cheaper still but does not support Workers AI's JSON
mode and is weaker at nested JSON; this one is not in JSON mode either, so the reply is cut
from the first `{` to the last `}` and validated instead.

## Cost

Workers AI bills in neurons: 10,000 a day are free on every plan, and beyond that Workers
Paid charges $0.011 per 1,000. On the 8B model that is $0.045 per million input tokens and
$0.384 per million output.

A typical draft is about 800 tokens in and 250 out, roughly **$0.00013**; the worst case,
with long zones and the 1024-token output cap, is about $0.0005. The free allocation covers
roughly 800 typical drafts a day. On Workers Free, calls past it fail rather than bill.

## Switching it off

Without a deploy, and surviving later ones:

```bash
npx wrangler secret put QUICK_ADD     # enter: off
npx wrangler secret delete QUICK_ADD  # back on
```

It is a secret rather than a `vars` entry because a deploy overwrites dashboard vars. Off,
the route answers `503`, `/api/me` reports `quick_add: false` and the dashboard hides the
button. Removing the `ai` binding from `wrangler.jsonc` does the same at the next deploy.

## Testing

Workers AI has no local simulator. `vitest.config.ts` renames the wrangler binding out of
the way and binds `AI` to the `WorkersAi` entrypoint of `test/upstream-provider.js`, which
answers with whatever a test arranged and records each call.
